package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.OperationDetails.Result;
import com.atlassian.labs.restbrowser.catalog.OperationSource.Engine;
import org.junit.Test;

import java.util.List;
import java.util.Map;

import static com.atlassian.labs.restbrowser.catalog.CatalogTestSupport.parseJson;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.mock;

/**
 * Direct unit tests for {@link OperationTargetResolver} helpers, {@link OperationSource.Engine#parse},
 * and {@link OperationSource} guard/error responses.
 */
public class OperationSourceHelpersTest {

    @SuppressWarnings("unchecked")
    private static Map<String, Object> parseObj(String json) {
        return (Map<String, Object>) parseJson(json);
    }

    @Test
    public void targetResolverHelpersRankKeysFormatErrorsAndCleanNames() throws Exception {
        assertEquals(List.of(), OperationTargetResolver.rankSimilarKeys(null, List.of("a"), 5));
        assertEquals(List.of(), OperationTargetResolver.rankSimilarKeys("ping", List.of(), 5));

        List<String> ranked = OperationTargetResolver.rankSimilarKeys(
                "demo:GET:issue/ping",
                List.of("demo:POST:issue/create", "demo:GET:issue/ping-v2", "other:GET:issue/ping", "zeta:GET:alpha"),
                2);
        assertEquals(2, ranked.size());
        assertEquals("demo:GET:issue/ping-v2", ranked.get(0));
        assertEquals("other:GET:issue/ping", ranked.get(1));

        assertEquals("com.acme.foo", OperationTargetResolver.packageOf("com.acme.foo.Bar$Baz"));
        assertEquals("", OperationTargetResolver.packageOf("SimpleName"));
        assertEquals("Bar.Baz", OperationTargetResolver.simpleNameOf("com.acme.foo.Bar$Baz"));
        assertEquals("Ping", OperationTargetResolver.simpleNameOf("Ping"));
        assertNull(OperationTargetResolver.cleanMethodFilter("   "));
        assertEquals("getIssue", OperationTargetResolver.cleanMethodFilter("  getIssue  "));
        assertEquals("", OperationTargetResolver.stripLeadingSlashes(null));
        assertEquals("rest/api/2", OperationTargetResolver.stripLeadingSlashes("///rest/api/2"));

        Result disabled = OperationTargetResolver.disabledError();
        assertEquals(403, disabled.status());
        assertEquals("decompile-disabled", parseObj(disabled.json()).get("error"));

        Result badClass = OperationTargetResolver.invalidTargetError("invalid-class");
        assertEquals(400, badClass.status());
        assertEquals("invalid-class", parseObj(badClass.json()).get("error"));

        Result missingTarget = OperationTargetResolver.invalidTargetError("missing-class");
        assertEquals(400, missingTarget.status());
        assertEquals("missing-class", parseObj(missingTarget.json()).get("error"));

        Result withSugg = OperationTargetResolver.error(404, "unknown-operation", "Try search", List.of("op1", "op2"));
        Map<String, Object> parsed = parseObj(withSugg.json());
        assertEquals("unknown-operation", parsed.get("error"));
        assertEquals("Try search", parsed.get("hint"));
        assertEquals(List.of("op1", "op2"), parsed.get("suggestions"));
    }

    @Test
    public void engineParseAndOperationSourceErrorGuardsBehavePredictably() throws Exception {
        assertEquals(Engine.CFR, Engine.parse("cfr"));
        assertEquals(Engine.CFR, Engine.parse(" CFR "));
        assertEquals(Engine.VINEFLOWER, Engine.parse(null));
        assertEquals(Engine.VINEFLOWER, Engine.parse(""));
        assertEquals(Engine.VINEFLOWER, Engine.parse("vineflower"));
        assertEquals(Engine.VINEFLOWER, Engine.parse("unknown-engine"));

        OperationSource disabledSrc = new OperationSource(mock(ModuleDiscovery.class), () -> null, () -> false);
        assertEquals(403, disabledSrc.decompile(null, "java.lang.String", -1L, "class", null).status());
        assertEquals(403, disabledSrc.inspectClass(null, "java.lang.String", -1L).status());
        assertEquals(403, disabledSrc.searchClasses("String", 10, null).status());
        assertEquals(403, disabledSrc.grepBytecode("hello", false, true, null, null, null, 10).status());
        assertEquals(403, disabledSrc.traverseGraph(null, "java.lang.String", -1L, 1, 5, false, true, null, false, null).status());
        assertEquals(403, disabledSrc.inspectResource(1L, null, "plugin.xml", null, null, null, false, 10).status());
        assertEquals(403, disabledSrc.inspectSchema(null, "java.lang.String", -1L, 2, true).status());

        OperationSource enabledSrc = new OperationSource(mock(ModuleDiscovery.class), () -> null, () -> true);
        assertEquals("query-too-short", parseObj(enabledSrc.searchClasses("a", 10, null).json()).get("error"));
        assertEquals("invalid-class", parseObj(enabledSrc.searchClasses("a..b", 10, null).json()).get("error"));
        assertEquals("query-too-short", parseObj(enabledSrc.grepBytecode(" x ", false, true, null, null, null, 10).json()).get("error"));
        assertEquals("missing-bundle", parseObj(enabledSrc.inspectResource(null, null, null, null, null, null, false, 10).json()).get("error"));
        assertEquals("missing-classes", parseObj(enabledSrc.batchItems(List.of()).json()).get("error"));
        assertEquals("invalid-class", parseObj(enabledSrc.decompile(null, "com..Bad", -1L, "class", null).json()).get("error"));

        Result notFound = enabledSrc.inspectClass(null, "com.example.definitely.Missing$$ClassName", -1L);
        assertEquals(404, notFound.status());
        assertEquals("class-not-found", parseObj(notFound.json()).get("error"));
        assertTrue(String.valueOf(parseObj(notFound.json()).get("hint")).contains("/code/search"));

        assertEquals(List.of("a.B", "c.D"), OperationSource.parseCandidates("a.B, c.D , ;"));
        assertEquals(List.of("a.Outer.Inner", "a.Outer$Inner", "a$Outer$Inner"),
                OperationSource.nestedVariants("a.Outer.Inner"));
    }
}
