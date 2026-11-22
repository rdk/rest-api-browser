package com.atlassian.labs.restbrowser.catalog;

import org.junit.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;

public class JsonTest {

    private static String str(String s) {
        return new Json().value(s).toString();
    }

    @Test
    public void escapesQuotesAndBackslashes() {
        assertEquals("\"a\\\"b\\\\c\"", str("a\"b\\c"));
    }

    @Test
    public void escapesControlCharacters() {
        assertEquals("\"\\n\\r\\t\"", str("\n\r\t"));
        assertEquals("\"\\u0001\\u001f\"", str("\u0001\u001f"));
        assertEquals("\"\\u0000\"", str("\u0000"));
    }

    @Test
    public void escapesLessThanAndLineSeparators() {
        assertEquals("\"\\u003c/script>\"", str("</script>"));
        assertEquals("\"\\u2028\\u2029\"", str("\u2028\u2029"));
    }

    @Test
    public void leavesOtherUnicodeAlone() {
        assertEquals("\"\u00e9\u4e2d>\"", str("\u00e9\u4e2d>"));
    }

    @Test
    public void nullStringIsJsonNull() {
        assertEquals("null", str(null));
    }

    @Test
    public void putsCommasBetweenValuesOnly() {
        Json j = new Json().beginArray().value("a").value(1L).value(true).beginObject().endObject().beginArray()
                .endArray().endArray();
        assertEquals("[\"a\",1,true,{},[]]", j.toString());
    }

    @Test
    public void putsCommasBetweenFields() {
        Json j = new Json().beginObject().field("a", "x").field("b", 2L).field("c", false)
                .name("d").beginObject().field("e", "y").endObject().field("f", "z").endObject();
        assertEquals("{\"a\":\"x\",\"b\":2,\"c\":false,\"d\":{\"e\":\"y\"},\"f\":\"z\"}", j.toString());
    }

    @Test
    public void optionalSkipsNullAndKeepsCommasRight() {
        Json j = new Json().beginObject().optional("a", null).optional("b", "x").optional("c", null)
                .optional("d", "y").endObject();
        assertEquals("{\"b\":\"x\",\"d\":\"y\"}", j.toString());
        assertEquals("{}", new Json().beginObject().optional("a", null).endObject().toString());
    }

    @Test
    public void stringsAndMapsAndRaw() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("k1", "v1");
        m.put("k2", null);
        Json j = new Json().beginObject().strings("s", List.of("a", "b")).stringMap("m", m).name("r").raw("[1]")
                .field("n", "x").endObject();
        assertEquals("{\"s\":[\"a\",\"b\"],\"m\":{\"k1\":\"v1\",\"k2\":null},\"r\":[1],\"n\":\"x\"}", j.toString());
    }

    @Test
    public void fieldNamesAreEscapedToo() {
        assertEquals("{\"a\\\"b\":1}", new Json().beginObject().field("a\"b", 1L).endObject().toString());
    }

    @Test
    public void outputParsesBack() {
        String tricky = "q\" b\\ n\n t\t c\u0001 <\u2028 \u00e9";
        String json = new Json().beginObject().field("v", tricky).endObject().toString();
        @SuppressWarnings("unchecked")
        Map<String, Object> parsed = (Map<String, Object>) CatalogTestSupport.parseJson(json);
        assertEquals(tricky, parsed.get("v"));
    }
}
