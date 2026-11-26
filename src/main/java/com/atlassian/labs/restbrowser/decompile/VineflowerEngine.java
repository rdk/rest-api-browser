package com.atlassian.labs.restbrowser.decompile;

import com.atlassian.labs.restbrowser.inspect.BytecodeReader;
import com.atlassian.labs.restbrowser.inspect.ClassFileInspector;
import org.jetbrains.java.decompiler.api.Decompiler;
import org.jetbrains.java.decompiler.main.DecompilerContext;
import org.jetbrains.java.decompiler.main.extern.IContextSource;
import org.jetbrains.java.decompiler.main.extern.IFernflowerLogger;
import org.jetbrains.java.decompiler.main.extern.IFernflowerPreferences;
import org.jetbrains.java.decompiler.main.extern.IResultSaver;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import java.util.jar.Manifest;

/**
 * Thread-safe embedded Vineflower engine:
 * <ul>
 *     <li>Uses {@link IFernflowerPreferences#THREADS} ({@code "thread-count"}) instead of short {@code "thr"} to bypass
 *     Vineflower's unsynchronized {@code OptionParser.SHORT_TO_LONG_NAME_MAP} initialization race.</li>
 *     <li>Caps per-method processing time via {@link IFernflowerPreferences#MAX_PROCESSING_METHOD}.</li>
 *     <li>Clears {@link DecompilerContext} in {@code finally} so OSGi classloaders are never pinned to Tomcat threads
 *     when builder initialization fails.</li>
 *     <li>Uses an {@link AtomicReference} sink and returns {@code null} on missing library entries.</li>
 * </ul>
 */
public final class VineflowerEngine implements DecompilerEngine {

    public static final String ID = "vineflower";
    public static final String DISPLAY_NAME = "Vineflower 1.11.1";
    private static final String MAX_METHOD_SECONDS = "30";

    static {
        try {
            org.jetbrains.java.decompiler.struct.attr.StructGeneralAttribute.init();
            org.jetbrains.java.decompiler.main.plugins.PluginSources.PLUGIN_SOURCES.clear();
            Field initField = org.jetbrains.java.decompiler.main.Init.class.getDeclaredField("initialized");
            initField.setAccessible(true);
            initField.setBoolean(null, true);
        } catch (ReflectiveOperationException | RuntimeException | LinkageError ignored) {
            // Fall back to default Vineflower initialization if internal fields change
        }
    }

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
        return decompileWithDiagnostics(input, options).source();
    }

    @Override
    public DecompileOutput decompileWithDiagnostics(BytecodeInput input, DecompileOptions options) {
        String className = input.className();
        ClassLoader loader = input.loader();
        byte[] classBytes = input.primaryBytes();
        String methodName = options == null ? null : options.methodName();
        int overloadParams = options == null ? -1 : options.overloadParamCount();
        List<String> capturedWarnings = new ArrayList<>();

        String internalBase = className.replace('.', '/');
        Map<String, byte[]> inputClasses = new LinkedHashMap<>();
        inputClasses.put(internalBase, classBytes);
        inputClasses.putAll(ClassFileInspector.collectNestedClassBytes(loader, className, classBytes));

        AtomicReference<String> out = new AtomicReference<>();
        IContextSource sourceInput = new IContextSource() {
            @Override
            public String getName() {
                return "memory";
            }

            @Override
            public Entries getEntries() {
                List<Entry> list = new ArrayList<>(inputClasses.size());
                for (String base : inputClasses.keySet()) {
                    list.add(Entry.atBase(base));
                }
                return new Entries(list, List.of(), List.of());
            }

            @Override
            public byte[] getClassBytes(String path) {
                String base = path.endsWith(CLASS_SUFFIX)
                        ? path.substring(0, path.length() - CLASS_SUFFIX.length())
                        : path;
                byte[] b = inputClasses.get(base);
                if (b != null) {
                    return b;
                }
                String res = path.endsWith(CLASS_SUFFIX) ? path : path + CLASS_SUFFIX;
                return BytecodeReader.readWithFallback(loader, res);
            }

            @Override
            public InputStream getInputStream(String resource) {
                byte[] b = getClassBytes(resource);
                return b == null ? null : new ByteArrayInputStream(b);
            }

            @Override
            public IOutputSink createOutputSink(IResultSaver saver) {
                return new IOutputSink() {
                    @Override public void begin() {}
                    @Override public void acceptClass(String qualifiedName, String fileName, String content, int[] mapping) {
                        if (content != null) {
                            if (internalBase.equals(qualifiedName)) {
                                out.set(content);
                            } else {
                                out.compareAndSet(null, content);
                            }
                        }
                    }
                    @Override public void acceptDirectory(String directory) {}
                    @Override public void acceptOther(String path) {}
                    @Override public void close() {}
                };
            }
        };

        IContextSource libs = new IContextSource() {
            @Override public String getName() { return "classpath"; }
            @Override public Entries getEntries() { return Entries.EMPTY; }
            @Override public boolean isLazy() { return true; }
            @Override public boolean hasClass(String path) {
                return BytecodeReader.exists(loader, path.endsWith(CLASS_SUFFIX) ? path : path + CLASS_SUFFIX);
            }
            @Override public byte[] getClassBytes(String path) {
                return BytecodeReader.readWithFallback(loader, path.endsWith(CLASS_SUFFIX) ? path : path + CLASS_SUFFIX);
            }
            @Override public InputStream getInputStream(String resource) {
                byte[] b = getClassBytes(resource);
                return b == null ? null : new ByteArrayInputStream(b);
            }
        };

        IResultSaver noOpSaver = new IResultSaver() {
            @Override public void saveFolder(String path) {}
            @Override public void copyFile(String source, String path, String entryName) {}
            @Override public void saveClassFile(String path, String qualifiedName, String entryName, String content, int[] mapping) {
                if (content != null) {
                    if (internalBase.equals(qualifiedName)) {
                        out.set(content);
                    } else {
                        out.compareAndSet(null, content);
                    }
                }
            }
            @Override public void createArchive(String path, String archiveName, Manifest manifest) {}
            @Override public void saveDirEntry(String path, String archiveName, String entryName) {}
            @Override public void copyEntry(String source, String path, String archiveName, String entryName) {}
            @Override public void saveClassEntry(String path, String archiveName, String qualifiedName, String entryName, String content) {
                saveClassFile(path, qualifiedName, entryName, content, null);
            }
            @Override public void closeArchive(String path, String archiveName) {}
        };

        IFernflowerLogger warningLogger = new IFernflowerLogger() {
            @Override
            public boolean accepts(Severity severity) {
                return severity == Severity.WARN || severity == Severity.ERROR;
            }

            @Override
            public void writeMessage(String message, Severity severity) {
                recordWarning(capturedWarnings, severity, message, null);
            }

            @Override
            public void writeMessage(String message, Severity severity, Throwable t) {
                recordWarning(capturedWarnings, severity, message, t);
            }
        };

        try {
            Decompiler.builder()
                    .inputs(sourceInput)
                    .libraries(libs)
                    .output(noOpSaver)
                    .logger(warningLogger)
                    .option(IFernflowerPreferences.DECOMPILE_GENERIC_SIGNATURES, "1")
                    .option(IFernflowerPreferences.INDENT_STRING, "    ")
                    .option(IFernflowerPreferences.INCLUDE_JAVA_RUNTIME, "0")
                    .option(IFernflowerPreferences.THREADS, "1")
                    .option(IFernflowerPreferences.MAX_PROCESSING_METHOD, MAX_METHOD_SECONDS)
                    .build()
                    .decompile();
        } finally {
            DecompilerContext.setCurrentContext(null);
        }

        String normalized = DecompilerEngine.cleanSource(out.get(), Integer.MAX_VALUE);
        if (normalized == null) {
            return new DecompileOutput(null, List.copyOf(capturedWarnings));
        }
        String result = normalized;
        if (methodName != null && !methodName.isBlank()) {
            String extracted = SourceMethodExtractor.extractMethod(normalized, methodName, overloadParams);
            if (extracted != null) {
                result = extracted;
            }
        }
        String clean = DecompilerEngine.cleanSource(result, DEFAULT_MAX_SOURCE);
        for (String w : DecompilerEngine.detectSourceWarnings(clean)) {
            if (capturedWarnings.size() < 10 && !capturedWarnings.contains(w)) {
                capturedWarnings.add(w);
            }
        }
        return new DecompileOutput(clean, List.copyOf(capturedWarnings));
    }

    private static void recordWarning(List<String> out, IFernflowerLogger.Severity severity,
                                      String message, Throwable t) {
        if ((severity != IFernflowerLogger.Severity.WARN && severity != IFernflowerLogger.Severity.ERROR)
                || out.size() >= 10 || message == null || message.isBlank()) {
            return;
        }
        String line = message.trim();
        if (t != null && t.getClass() != null) {
            line = line + " (" + t.getClass().getSimpleName() + ")";
        }
        if (line.length() > 240) {
            line = line.substring(0, 240) + "…";
        }
        if (!out.contains(line)) {
            out.add(line);
        }
    }
}
