package com.atlassian.labs.restbrowser.decompile;

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

    String id();

    String displayName();

    String decompile(BytecodeInput input, DecompileOptions options);

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
