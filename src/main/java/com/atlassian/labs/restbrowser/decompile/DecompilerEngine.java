package com.atlassian.labs.restbrowser.decompile;

import java.util.ArrayList;
import java.util.List;

/**
 * Pluggable bytecode decompiler engine (Vineflower, CFR, etc.). Zero Atlassian coupling.
 */
public interface DecompilerEngine {

    int DEFAULT_MAX_SOURCE = 200_000;

    record BytecodeInput(String className, ClassLoader loader, byte[] primaryBytes) {
    }

    record DecompileOptions(String methodName, int overloadParamCount) {
        public DecompileOptions(String methodName) {
            this(methodName, -1);
        }
    }

    record DecompileOutput(String source, List<String> warnings) {
    }

    String id();

    String displayName();

    String decompile(BytecodeInput input, DecompileOptions options);

    default DecompileOutput decompileWithDiagnostics(BytecodeInput input, DecompileOptions options) {
        String source = decompile(input, options);
        return new DecompileOutput(source, detectSourceWarnings(source));
    }

    static List<String> detectSourceWarnings(String source) {
        if (source == null || source.isEmpty()) {
            return List.of();
        }
        List<String> warnings = new ArrayList<>();
        if (source.contains("$VF: Couldn't be decompiled") || source.contains("$VF: Unable to simplify")) {
            warnings.add("Vineflower reported incomplete decompilation in one or more methods; try decompiler=cfr.");
        }
        if (source.contains("Unable to decompile") || source.contains("Failed to decompile")
                || source.contains("Exception decompiling")) {
            warnings.add("Decompiler emitted incomplete/fallback code markers.");
        }
        return List.copyOf(warnings);
    }

    static String cleanSource(String raw, int maxChars) {
        if (raw == null) {
            return null;
        }
        String s = raw.replace("\r\n", "\n").replace('\r', '\n');
        if (s.startsWith("/*\n * Decompiled with CFR")) {
            int end = s.indexOf("*/");
            if (end > 0) {
                s = s.substring(end + 2);
            }
        }
        s = s.strip();
        if (s.isEmpty()) {
            return null;
        }
        if (s.length() > maxChars) {
            int end = Character.isHighSurrogate(s.charAt(maxChars - 1)) ? maxChars - 1 : maxChars;
            return s.substring(0, end) + "…";
        }
        return s;
    }
}
