package com.atlassian.labs.restbrowser.decompile;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Lexer-aware Java method/constructor extractor and header line locator.
 * <p>
 * Handles Java 15+ text blocks ({@code """..."""}), block/line comments, multiline annotations ({@code @Operation(...)}),
 * nested generic method type parameters ({@code <T extends List<String>>}), inline type-use annotations, nested
 * classes with arbitrary indentation, constructors, and optional parameter-count overload matching.
 */
public final class SourceMethodExtractor {

    private SourceMethodExtractor() {
    }

    /** 1-based line number of {@code methodName} in {@code source}, or 0 if not found. */
    public static int findMethodLine(String source, String methodName) {
        return findMethodLine(source, methodName, -1);
    }

    /** 1-based line number matching optional parameter count when overloads exist (falls back to first match). */
    public static int findMethodLine(String source, String methodName, int overloadParamCount) {
        if (source == null || methodName == null || methodName.isBlank()) {
            return 0;
        }
        String[] lines = source.split("\n", -1);
        Pattern sig = methodHeaderPattern(methodName);
        boolean inBlockComment = false;
        boolean inTextBlock = false;
        int firstMatch = 0;
        for (int i = 0; i < lines.length; i++) {
            LineScan scan = scanCodeState(lines[i], inBlockComment, inTextBlock);
            inBlockComment = scan.inBlockComment;
            inTextBlock = scan.inTextBlock;
            if (!scan.hasCode) {
                continue;
            }
            Matcher m = sig.matcher(lines[i]);
            if (m.find() && isCandidateHeader(lines[i], m, methodName)) {
                int openParenCol = m.end() - 1;
                boolean ctorWithoutPrefix = hasEmptyPrefix(lines[i], m, methodName);
                if (findMethodEnd(lines, i, openParenCol, ctorWithoutPrefix) < i) {
                    continue;
                }
                int lineNo = i + 1;
                if (overloadParamCount >= 0) {
                    int count = countHeaderParams(lines, i, openParenCol);
                    if (count == overloadParamCount) {
                        return lineNo;
                    }
                    if (firstMatch == 0) {
                        firstMatch = lineNo;
                    }
                } else {
                    return lineNo;
                }
            }
        }
        return firstMatch;
    }

    public static String extractMethod(String classSource, String methodName) {
        return extractMethod(classSource, methodName, -1);
    }

    public static String extractMethod(String classSource, String methodName, int overloadParamCount) {
        if (classSource == null || methodName == null || methodName.isBlank()) {
            return null;
        }
        String[] lines = classSource.split("\n", -1);
        Pattern sig = methodHeaderPattern(methodName);
        List<String> exactMatches = new ArrayList<>();
        List<String> allMatches = new ArrayList<>();
        boolean inBlockComment = false;
        boolean inTextBlock = false;

        int i = 0;
        while (i < lines.length) {
            LineScan scan = scanCodeState(lines[i], inBlockComment, inTextBlock);
            inBlockComment = scan.inBlockComment;
            inTextBlock = scan.inTextBlock;
            if (!scan.hasCode) {
                i++;
                continue;
            }
            Matcher m = sig.matcher(lines[i]);
            if (!m.find() || !isCandidateHeader(lines[i], m, methodName)) {
                i++;
                continue;
            }
            int openParenCol = m.end() - 1;
            int paramCount = overloadParamCount >= 0 ? countHeaderParams(lines, i, openParenCol) : -1;
            int start = walkBackAnnotations(lines, i);
            int end = findMethodEnd(lines, i, openParenCol, hasEmptyPrefix(lines[i], m, methodName));
            if (end < i) {
                i++;
                continue;
            }
            String block = sliceBlock(lines, start, end, leadingSpaces(lines[i]));
            allMatches.add(block);
            if (overloadParamCount >= 0 && paramCount == overloadParamCount) {
                exactMatches.add(block);
            }
            // Advance comment/text-block state cleanly to end + 1
            for (int k = i + 1; k <= end && k < lines.length; k++) {
                LineScan step = scanCodeState(lines[k], inBlockComment, inTextBlock);
                inBlockComment = step.inBlockComment;
                inTextBlock = step.inTextBlock;
            }
            i = end + 1;
        }
        List<String> chosen = !exactMatches.isEmpty() ? exactMatches : allMatches;
        return chosen.isEmpty() ? null : String.join("\n\n", chosen);
    }

    private static Pattern methodHeaderPattern(String methodName) {
        // Allows arbitrary indentation, optional modifiers, nested `<...>` generic method type params (up to 2 levels),
        // inline `@Annotation` on return type, return type OR constructor (empty return type).
        return Pattern.compile("^\\s*(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\\s+)*"
                + "(?:@(?:[\\w$.]+)(?:\\([^)]*\\))?\\s+)*"
                + "(?:<(?:[^<>]|<[^>]*>)*>\\s+)?"
                + "(?:(?:@(?:[\\w$.]+)(?:\\([^)]*\\))?\\s+)*(?:[\\w$.<>?, \\[\\]]+?)\\s+)?"
                + Pattern.quote(methodName) + "\\s*\\(");
    }

    private static final Pattern CONTROL_OR_TYPE_KEYWORD = Pattern.compile(
            "\\b(?:if|for|while|switch|case|try|catch|return|throw|new|else|do|assert|yield|instanceof|class|interface|enum|record)\\b|@interface\\b");

    private static boolean hasEmptyPrefix(String line, Matcher m, String methodName) {
        int openParenCol = m.end() - 1;
        int namePos = line.lastIndexOf(methodName, openParenCol);
        if (namePos < 0) {
            return false;
        }
        return stripAnnotationArgs(line.substring(m.start(), namePos)).trim().isEmpty();
    }

    private static boolean isCandidateHeader(String line, Matcher m, String methodName) {
        int openParenCol = m.end() - 1;
        int namePos = line.lastIndexOf(methodName, openParenCol);
        if (namePos < 0) {
            return false;
        }
        String rawPrefix = line.substring(m.start(), namePos);
        String strippedPrefix = stripGenericArgs(stripAnnotationArgs(rawPrefix)).trim();
        if (strippedPrefix.indexOf('=') >= 0
                || strippedPrefix.indexOf(',') >= 0
                || strippedPrefix.indexOf('?') >= 0
                || strippedPrefix.indexOf(':') >= 0
                || CONTROL_OR_TYPE_KEYWORD.matcher(strippedPrefix).find()) {
            return false;
        }
        if (strippedPrefix.isEmpty()) {
            // Only constructors may omit a return type; constructors are capitalized and never end in ';' on a single-line call.
            String trimmedLine = line.trim();
            if (!Character.isUpperCase(methodName.charAt(0)) || trimmedLine.endsWith(";")) {
                return false;
            }
        }
        return true;
    }

    /** Strips balanced {@code <...>} generic parameter spans so commas/wildcards inside types do not look like call expressions. */
    private static String stripGenericArgs(String prefix) {
        if (prefix.indexOf('<') < 0) {
            return prefix;
        }
        StringBuilder out = new StringBuilder(prefix.length());
        int depth = 0;
        for (int c = 0; c < prefix.length(); c++) {
            char ch = prefix.charAt(c);
            if (ch == '<') {
                depth++;
            } else if (ch == '>') {
                depth = Math.max(0, depth - 1);
            } else if (depth == 0) {
                out.append(ch);
            }
        }
        return out.toString();
    }

    /** Strips balanced {@code (...)} annotation argument spans so {@code =} or type keywords inside annotations are ignored. */
    private static String stripAnnotationArgs(String prefix) {
        if (prefix.indexOf('(') < 0) {
            return prefix;
        }
        StringBuilder out = new StringBuilder(prefix.length());
        int depth = 0;
        boolean inStr = false;
        boolean inChr = false;
        for (int c = 0; c < prefix.length(); c++) {
            char ch = prefix.charAt(c);
            if (inStr) {
                if (ch == '\\') c++;
                else if (ch == '"') inStr = false;
                continue;
            }
            if (inChr) {
                if (ch == '\\') c++;
                else if (ch == '\'') inChr = false;
                continue;
            }
            if (ch == '"') {
                inStr = true;
            } else if (ch == '\'') {
                inChr = true;
            } else if (ch == '(') {
                depth++;
            } else if (ch == ')') {
                depth = Math.max(0, depth - 1);
            } else if (depth == 0) {
                out.append(ch);
            }
        }
        return out.toString();
    }

    /**
     * Walks backward from method header line {@code headerLine} over single-line AND multiline {@code @Annotation(...)}
     * blocks (counting delimiters left-to-right outside string/char literals and comments).
     */
    private static int walkBackAnnotations(String[] lines, int headerLine) {
        int start = headerLine;
        int parenDebt = 0;
        int braceDebt = 0;
        for (int k = headerLine - 1; k >= 0; k--) {
            String trimmed = lines[k].trim();
            int[] delta = netDelimiters(lines[k]);
            if (parenDebt > 0 || braceDebt > 0) {
                parenDebt += delta[0];
                braceDebt += delta[1];
                start = k;
                if (parenDebt <= 0 && braceDebt <= 0) {
                    parenDebt = 0;
                    braceDebt = 0;
                    if (!trimmed.startsWith("@") && k > 0 && !lines[k - 1].trim().startsWith("@")) {
                        // Continue normal check on k-1 in next iteration
                        continue;
                    }
                }
                continue;
            }
            if (trimmed.isEmpty()) {
                break;
            }
            if (trimmed.startsWith("@")) {
                start = k;
                continue;
            }
            // Ending of a multi-line annotation directly above (e.g. `)` or `})`)
            if ((trimmed.endsWith(")") || trimmed.endsWith("})")) && (delta[0] > 0 || delta[1] > 0)) {
                parenDebt = Math.max(0, delta[0]);
                braceDebt = Math.max(0, delta[1]);
                start = k;
                continue;
            }
            break;
        }
        return start;
    }

    /** Returns {@code { closeMinusOpenParen, closeMinusOpenBrace }} outside string/char literals and comments. */
    private static int[] netDelimiters(String line) {
        int paren = 0;
        int brace = 0;
        boolean inStr = false;
        boolean inChr = false;
        for (int c = 0; c < line.length(); c++) {
            char ch = line.charAt(c);
            char next = c + 1 < line.length() ? line.charAt(c + 1) : 0;
            if (inStr) {
                if (ch == '\\') c++;
                else if (ch == '"') inStr = false;
                continue;
            }
            if (inChr) {
                if (ch == '\\') c++;
                else if (ch == '\'') inChr = false;
                continue;
            }
            if (ch == '/' && next == '/') break;
            if (ch == '"') inStr = true;
            else if (ch == '\'') inChr = true;
            else if (ch == ')') paren++;
            else if (ch == '(') paren--;
            else if (ch == '}') brace++;
            else if (ch == '{') brace--;
        }
        return new int[]{paren, brace};
    }

    private static int countHeaderParams(String[] lines, int startLine, int openParenCol) {
        int depth = 0;
        int angle = 0;
        int commas = 0;
        boolean hasToken = false;
        boolean inBlockComment = false;
        boolean inTextBlock = false;
        for (int i = startLine; i < Math.min(lines.length, startLine + 40); i++) {
            String line = lines[i];
            boolean inStr = false;
            boolean inChr = false;
            int colStart = i == startLine ? Math.max(0, openParenCol) : 0;
            for (int c = colStart; c < line.length(); c++) {
                char ch = line.charAt(c);
                char next = c + 1 < line.length() ? line.charAt(c + 1) : 0;
                char next2 = c + 2 < line.length() ? line.charAt(c + 2) : 0;
                if (inBlockComment) {
                    if (ch == '*' && next == '/') { inBlockComment = false; c++; }
                    continue;
                }
                if (inTextBlock) {
                    if (ch == '\\') { c++; }
                    else if (ch == '"' && next == '"' && next2 == '"') { inTextBlock = false; c += 2; }
                    continue;
                }
                if (inStr) {
                    if (ch == '\\') { c++; }
                    else if (ch == '"') { inStr = false; }
                    continue;
                }
                if (inChr) {
                    if (ch == '\\') { c++; }
                    else if (ch == '\'') { inChr = false; }
                    continue;
                }
                if (ch == '/' && next == '/') break;
                if (ch == '/' && next == '*') { inBlockComment = true; c++; continue; }
                if (ch == '"' && next == '"' && next2 == '"') { inTextBlock = true; c += 2; continue; }
                if (ch == '"') { inStr = true; continue; }
                if (ch == '\'') { inChr = true; continue; }

                if (ch == '(') {
                    depth++;
                } else if (ch == ')') {
                    depth--;
                    if (depth == 0) {
                        return hasToken ? commas + 1 : 0;
                    }
                } else if (depth == 1) {
                    if (ch == '<') angle++;
                    else if (ch == '>') angle = Math.max(0, angle - 1);
                    else if (ch == ',' && angle == 0) commas++;
                    else if (!Character.isWhitespace(ch)) hasToken = true;
                }
            }
        }
        return -1;
    }

    private static int findMethodEnd(String[] lines, int startLine, int openParenCol, boolean requireBodyBrace) {
        int braceDepth = 0;
        int parenDepth = 0;
        boolean seenParamClose = false;
        boolean seenBrace = false;
        boolean inBlockComment = false;
        boolean inTextBlock = false;
        for (int i = startLine; i < lines.length; i++) {
            String line = lines[i];
            boolean inStr = false;
            boolean inChr = false;
            int colStart = i == startLine ? Math.max(0, openParenCol) : 0;
            for (int c = colStart; c < line.length(); c++) {
                char ch = line.charAt(c);
                char next = c + 1 < line.length() ? line.charAt(c + 1) : 0;
                char next2 = c + 2 < line.length() ? line.charAt(c + 2) : 0;
                if (inBlockComment) {
                    if (ch == '*' && next == '/') { inBlockComment = false; c++; }
                    continue;
                }
                if (inTextBlock) {
                    if (ch == '\\') { c++; }
                    else if (ch == '"' && next == '"' && next2 == '"') { inTextBlock = false; c += 2; }
                    continue;
                }
                if (inStr) {
                    if (ch == '\\') { c++; }
                    else if (ch == '"') { inStr = false; }
                    continue;
                }
                if (inChr) {
                    if (ch == '\\') { c++; }
                    else if (ch == '\'') { inChr = false; }
                    continue;
                }
                if (ch == '/' && next == '/') break;
                if (ch == '/' && next == '*') { inBlockComment = true; c++; continue; }
                if (ch == '"' && next == '"' && next2 == '"') { inTextBlock = true; c += 2; continue; }
                if (ch == '"') { inStr = true; }
                else if (ch == '\'') { inChr = true; }
                else if (ch == '(') { parenDepth++; }
                else if (ch == ')') {
                    if (parenDepth > 0) {
                        parenDepth--;
                        if (parenDepth == 0) {
                            seenParamClose = true;
                        }
                    }
                } else if (parenDepth == 0 && seenParamClose) {
                    if (ch == '{') { braceDepth++; seenBrace = true; }
                    else if (ch == '}') {
                        braceDepth--;
                        if (seenBrace && braceDepth == 0) {
                            return i;
                        }
                    } else if (ch == ';' && !seenBrace && braceDepth == 0) {
                        return requireBodyBrace ? -1 : i;
                    }
                }
            }
        }
        return -1;
    }

    private record LineScan(boolean inBlockComment, boolean inTextBlock, boolean hasCode) {
    }

    private static LineScan scanCodeState(String line, boolean inBlockComment, boolean inTextBlock) {
        boolean inStr = false;
        boolean inChr = false;
        boolean hasCode = false;
        for (int c = 0; c < line.length(); c++) {
            char ch = line.charAt(c);
            char next = c + 1 < line.length() ? line.charAt(c + 1) : 0;
            char next2 = c + 2 < line.length() ? line.charAt(c + 2) : 0;
            if (inBlockComment) {
                if (ch == '*' && next == '/') { inBlockComment = false; c++; }
                continue;
            }
            if (inTextBlock) {
                if (ch == '\\') { c++; }
                else if (ch == '"' && next == '"' && next2 == '"') { inTextBlock = false; c += 2; }
                continue;
            }
            if (inStr) {
                if (ch == '\\') { c++; }
                else if (ch == '"') { inStr = false; }
                continue;
            }
            if (inChr) {
                if (ch == '\\') { c++; }
                else if (ch == '\'') { inChr = false; }
                continue;
            }
            if (ch == '/' && next == '/') break;
            if (ch == '/' && next == '*') { inBlockComment = true; c++; continue; }
            if (ch == '"' && next == '"' && next2 == '"') { inTextBlock = true; c += 2; continue; }
            if (!Character.isWhitespace(ch)) {
                hasCode = true;
            }
            if (ch == '"') { inStr = true; }
            else if (ch == '\'') { inChr = true; }
        }
        return new LineScan(inBlockComment, inTextBlock, hasCode);
    }

    private static String sliceBlock(String[] lines, int start, int end, int commonIndent) {
        StringBuilder block = new StringBuilder();
        for (int k = start; k <= end; k++) {
            String line = lines[k];
            if (commonIndent > 0 && line.length() >= commonIndent && line.substring(0, commonIndent).isBlank()) {
                line = line.substring(commonIndent);
            }
            if (block.length() > 0) {
                block.append('\n');
            }
            block.append(line);
        }
        return block.toString();
    }

    private static int leadingSpaces(String s) {
        int n = 0;
        while (n < s.length() && s.charAt(n) == ' ') {
            n++;
        }
        return n;
    }
}
