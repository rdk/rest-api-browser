package com.atlassian.labs.restbrowser.decompile;

import com.atlassian.labs.restbrowser.inspect.BytecodeReader;
import org.benf.cfr.reader.api.CfrDriver;
import org.benf.cfr.reader.api.ClassFileSource;
import org.benf.cfr.reader.api.OutputSinkFactory;
import org.benf.cfr.reader.bytecode.analysis.parse.utils.Pair;

import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Embedded CFR 0.152 decompiler engine. Serves the primary class's already-read bytecode from memory and falls back
 * to full-class decompilation when a {@code methodname} filter emits an empty class shell. Zero Atlassian coupling.
 */
public final class CfrEngine implements DecompilerEngine {

    public static final String ID = "cfr";
    public static final String DISPLAY_NAME = "CFR 0.152";

    @Override
    public String id() {
        return ID;
    }

    @Override
    public String displayName() {
        return DISPLAY_NAME;
    }

    @Override
    public String decompile(BytecodeInput input, DecompileOptions options) {
        String internalPath = input.className().replace('.', '/') + ".class";
        String methodName = options == null ? null : options.methodName();
        int overloadParams = options == null ? -1 : options.overloadParamCount();

        String raw = invokeCfr(input.loader(), internalPath, input.primaryBytes(), methodName);
        String cleaned = DecompilerEngine.cleanSource(raw, DEFAULT_MAX_SOURCE);
        if (methodName != null && !methodName.isBlank()) {
            // CFR emits an empty class shell (`package ...; class Foo {}`) when methodname misses.
            if (cleaned == null || SourceMethodExtractor.findMethodLine(cleaned, methodName, overloadParams) == 0) {
                String fullRaw = invokeCfr(input.loader(), internalPath, input.primaryBytes(), null);
                String fullClean = DecompilerEngine.cleanSource(fullRaw, DEFAULT_MAX_SOURCE);
                if (fullClean != null) {
                    return fullClean;
                }
            }
        }
        return cleaned;
    }

    private static String invokeCfr(ClassLoader loader, String primaryPath, byte[] primaryBytes, String methodName) {
        StringBuilder out = new StringBuilder();
        ClassFileSource source = new ClassFileSource() {
            @Override
            public void informAnalysisRelativePathDetail(String usePath, String classFilePath) {
            }

            @Override
            public Collection<String> addJar(String jarPath) {
                return Collections.emptyList();
            }

            @Override
            public String getPossiblyRenamedPath(String path) {
                return path;
            }

            @Override
            public Pair<byte[], String> getClassFileContent(String path) throws IOException {
                byte[] bytes = primaryBytes != null && primaryPath.equals(path)
                        ? primaryBytes
                        : BytecodeReader.readWithFallback(loader, path);
                if (bytes == null) {
                    throw new FileNotFoundException(path);
                }
                return Pair.make(bytes, path);
            }
        };
        OutputSinkFactory sink = new OutputSinkFactory() {
            @Override
            public List<SinkClass> getSupportedSinks(SinkType sinkType, Collection<SinkClass> available) {
                return sinkType == SinkType.JAVA ? List.of(SinkClass.STRING) : Collections.emptyList();
            }

            @Override
            public <T> Sink<T> getSink(SinkType sinkType, SinkClass sinkClass) {
                if (sinkType == SinkType.JAVA && sinkClass == SinkClass.STRING) {
                    return s -> out.append(s);
                }
                return ignored -> { };
            }
        };
        Map<String, String> options = new LinkedHashMap<>();
        options.put("showversion", "false");
        options.put("hideutf", "false");
        options.put("silent", "true");
        if (methodName != null && !methodName.isBlank()) {
            options.put("methodname", methodName);
        }
        CfrDriver driver = new CfrDriver.Builder()
                .withClassFileSource(source)
                .withOutputSink(sink)
                .withOptions(options)
                .build();
        driver.analyse(List.of(primaryPath));
        return out.toString();
    }
}
