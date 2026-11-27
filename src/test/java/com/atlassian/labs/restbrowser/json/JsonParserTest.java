package com.atlassian.labs.restbrowser.json;

import com.atlassian.labs.restbrowser.json.JsonParser.JsonParseException;
import org.junit.Test;

import java.util.List;
import java.util.Map;

import static org.junit.Assert.*;

public class JsonParserTest {

    @Test
    @SuppressWarnings("unchecked")
    public void parsesPrimitivesEscapedStringsNumbersArraysAndOrderedObjects() {
        assertEquals(Boolean.TRUE, JsonParser.parse(" true "));
        assertEquals(Boolean.FALSE, JsonParser.parse("\n\tfalse\r"));
        assertNull(JsonParser.parse("null"));

        assertEquals(0L, JsonParser.parse("0"));
        assertEquals(0L, JsonParser.parse("-0"));
        assertEquals(42L, JsonParser.parse("42"));
        assertEquals(-9876543210L, JsonParser.parse("-9876543210"));
        assertEquals(3.25d, (Double) JsonParser.parse("3.25"), 1e-12);
        assertEquals(-1.5e2d, (Double) JsonParser.parse("-1.5E+2"), 1e-12);
        assertEquals(2e-3d, (Double) JsonParser.parse("2e-3"), 1e-12);

        String complexStr = "\"quote:\\\" slash:\\\\ fwd:\\/ nl:\\n cr:\\r tab:\\t bs:\\b ff:\\f hex:\\u0041\\u2014\"";
        assertEquals("quote:\" slash:\\ fwd:/ nl:\n cr:\r tab:\t bs:\b ff:\f hex:A\u2014", JsonParser.parse(complexStr));

        List<Object> arr = (List<Object>) JsonParser.parse("[1, \"two\", true, null, {\"nested\": [false]}]");
        assertEquals(5, arr.size());
        assertEquals(1L, arr.get(0));
        assertEquals("two", arr.get(1));
        assertEquals(Boolean.TRUE, arr.get(2));
        assertNull(arr.get(3));

        Map<String, Object> obj = JsonParser.parseObject("{\"z\":1,\"a\":{},\"m\":[]}");
        assertEquals(List.of("z", "a", "m"), List.copyOf(obj.keySet()));
        assertEquals(Map.of(), obj.get("a"));
        assertEquals(List.of(), obj.get("m"));
    }

    @Test
    public void honorsMaxDepthLimit() {
        String atLimit = "[".repeat(JsonParser.MAX_DEPTH) + "1" + "]".repeat(JsonParser.MAX_DEPTH);
        assertNotNull(JsonParser.parse(atLimit));

        String pastLimit = "[".repeat(JsonParser.MAX_DEPTH + 1) + "1" + "]".repeat(JsonParser.MAX_DEPTH + 1);
        assertThrows(JsonParseException.class, () -> JsonParser.parse(pastLimit));

        String nestedObjPastLimit = "{\"a\":".repeat(JsonParser.MAX_DEPTH + 1) + "1" + "}".repeat(JsonParser.MAX_DEPTH + 1);
        assertThrows(JsonParseException.class, () -> JsonParser.parse(nestedObjPastLimit));
    }

    @Test
    public void rejectsMalformedInputsAndNonObjectsInParseObject() {
        for (String bad : List.of(
                "   ",
                "{} trailing",
                "[1, 2",
                "{\"a\" 1}",
                "{\"a\":1 \"b\":2}",
                "\"unterminated",
                "\"bad\\",
                "\"bad\\x\"",
                "\"short\\u12\"",
                "\"nonhex\\u123g\"",
                "\"raw\nnewline\"",
                "tru",
                "-",
                "1.",
                "1e+",
                "1e9999",
                "99999999999999999999999999")) {
            assertThrows("Expected JsonParseException for: " + bad, JsonParseException.class, () -> JsonParser.parse(bad));
        }

        assertThrows(JsonParseException.class, () -> JsonParser.parse(null));
        assertThrows(JsonParseException.class, () -> JsonParser.parseObject("[1, 2]"));
        assertThrows(JsonParseException.class, () -> JsonParser.parseObject("\"hello\""));
    }
}
