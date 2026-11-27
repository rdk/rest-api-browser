package com.atlassian.labs.restbrowser.catalog;

import org.junit.Test;

import static org.junit.Assert.*;

public class AgentMarkdownTest {

    @Test
    public void truncateToCharsRespectsNullLimitsBoundariesAndNewlines() {
        String sample = "Line one\nLine two\nLine three\n" + "x".repeat(400);

        assertNull(AgentMarkdown.truncateToChars(null, 300));
        assertSame(sample, AgentMarkdown.truncateToChars(sample, null));
        assertSame(sample, AgentMarkdown.truncateToChars(sample, 0));
        assertSame(sample, AgentMarkdown.truncateToChars(sample, -10));

        // Short strings stay untouched
        assertEquals("short", AgentMarkdown.truncateToChars("short", 200));

        // Values below minimum budget clamp safely to 200
        String belowMin = "a\n".repeat(150);
        String cappedMin = AgentMarkdown.truncateToChars(belowMin, 50);
        assertTrue(cappedMin.length() <= 200);
        assertTrue(cappedMin.contains("truncated to 200 chars"));

        // Preserves clean newline boundary when near budget
        String multi = "row-001\n".repeat(40); // 320 chars
        String cut = AgentMarkdown.truncateToChars(multi, 240);
        assertTrue(cut.length() <= 240);
        assertTrue(cut.contains("\n\n… [truncated to 240 chars"));
        String prefix = cut.substring(0, cut.indexOf("\n\n…"));
        assertTrue(prefix.endsWith("row-001"));
    }

    @Test
    public void rendersSourceAndClassMarkdownFromJson() {
        String srcJson = "{\"format\":1,\"class\":\"demo.Hello\",\"scope\":\"method\",\"method\":\"run\","
                + "\"decompiler\":\"Vineflower\",\"startLine\":10,\"endLine\":12,\"totalLines\":40,"
                + "\"truncated\":true,\"lineNumbers\":true,\"source\":\"10 | return true;\"}";
        String md = AgentMarkdown.renderSourceJson(srcJson);
        assertTrue(md.contains("# demo.Hello"));
        assertTrue(md.contains("`run`"));
        assertTrue(md.contains("Lines**: 10-12 / 40"));
        assertTrue(md.contains("startLine=13"));
        assertTrue(md.contains("10 | return true;"));

        String errMd = AgentMarkdown.renderClassJson("{\"error\":\"class-not-found\",\"hint\":\"Try search.\"}");
        assertTrue(errMd.contains("class-not-found"));
    }
}
