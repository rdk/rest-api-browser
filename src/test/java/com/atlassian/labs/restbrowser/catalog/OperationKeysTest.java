package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.Model.Operation;
import com.atlassian.labs.restbrowser.catalog.Model.OperationSpec;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Random;

import static org.junit.Assert.assertEquals;

public class OperationKeysTest {

    private static OperationSpec spec(String method, String path, String... consumes) {
        return new OperationSpec(method, path, List.of(consumes), List.of("application/json"), List.of(), null,
                false, null);
    }

    private static List<String> keys(List<Operation> ops) {
        return ops.stream().map(Operation::key).toList();
    }

    @Test
    public void normalizesPlainTemplates() {
        assertEquals("issue/{}/comment/{}", OperationKeys.normalize("issue/{key}/comment/{id}"));
    }

    @Test
    public void normalizesTemplatesWithRegexContainingBraces() {
        assertEquals("a/{}/b", OperationKeys.normalize("a/{id: [0-9]{3}}/b"));
        assertEquals("{}", OperationKeys.normalize("{x:\\d{1,3}(a{2})?}"));
    }

    @Test
    public void normalizeLeavesPathsWithoutTemplates() {
        assertEquals("issue/search", OperationKeys.normalize("issue/search"));
        assertEquals("", OperationKeys.normalize(""));
    }

    @Test
    public void keyFormatIsModuleMethodPath() {
        List<Operation> ops = OperationKeys.assign("com.x:rest", List.of(spec("GET", "issue/{issueIdOrKey}")));
        assertEquals(List.of("com.x:rest:GET:issue/{}"), keys(ops));
        assertEquals("com.x:rest", ops.get(0).moduleId());
    }

    @Test
    public void keyDoesNotDependOnTemplateNames() {
        assertEquals(keys(OperationKeys.assign("m", List.of(spec("GET", "a/{x}")))),
                keys(OperationKeys.assign("m", List.of(spec("GET", "a/{y}")))));
    }

    @Test
    public void orderIsDeterministicRegardlessOfInput() {
        List<OperationSpec> specs = new ArrayList<>(List.of(
                spec("POST", "b"), spec("GET", "b"), spec("GET", "a"),
                spec("PUT", "b/{id}", "application/json"), spec("PUT", "b/{id}", "application/xml"),
                spec("PUT", "b/{name}")));
        List<Operation> reference = OperationKeys.assign("m", specs);
        for (int seed = 0; seed < 10; seed++) {
            List<OperationSpec> shuffled = new ArrayList<>(specs);
            Collections.shuffle(shuffled, new Random(seed));
            assertEquals(keys(reference), keys(OperationKeys.assign("m", shuffled)));
            assertEquals(reference.stream().map(Operation::spec).toList(),
                    OperationKeys.assign("m", shuffled).stream().map(Operation::spec).toList());
        }
    }

    @Test
    public void twoHandlersOfOneMethodAndPathGetSubtypeSuffixes() {
        List<Operation> ops = OperationKeys.assign("m", List.of(
                spec("POST", "upload", "application/xml"), spec("POST", "upload", "application/json")));
        // sorted by consumed types: json first keeps the plain key, xml gets its subtype
        assertEquals(List.of("m:POST:upload", "m:POST:upload#xml"), keys(ops));
        assertEquals("application/json", ops.get(0).spec().consumes().get(0));
    }

    @Test
    public void subtypeSuffixDropsParameters() {
        List<Operation> ops = OperationKeys.assign("m", List.of(
                spec("POST", "u", "application/json"), spec("POST", "u", "text/plain; charset=utf-8")));
        assertEquals(List.of("m:POST:u", "m:POST:u#plain"), keys(ops));
    }

    @Test
    public void handlersWithoutConsumedTypesGetACounter() {
        List<Operation> ops = OperationKeys.assign("m", List.of(
                spec("GET", "x/{id: [a-z]+}"), spec("GET", "x/{id: [0-9]+}"), spec("GET", "x/{id}")));
        assertEquals(List.of("m:GET:x/{}", "m:GET:x/{}#2", "m:GET:x/{}#3"), keys(ops));
    }

    @Test
    public void sameSubtypeTwiceFallsBackToCounter() {
        List<Operation> ops = OperationKeys.assign("m", List.of(
                spec("POST", "u/{a}", "application/json"), spec("POST", "u/{b}", "application/json"),
                spec("POST", "u/{c}", "text/json")));
        assertEquals(List.of("m:POST:u/{}", "m:POST:u/{}#json", "m:POST:u/{}#2"), keys(ops));
    }

    @Test
    public void differentMethodsOrPathsNeedNoSuffix() {
        List<Operation> ops = OperationKeys.assign("m", List.of(
                spec("GET", "a"), spec("POST", "a"), spec("GET", "b")));
        assertEquals(List.of("m:GET:a", "m:POST:a", "m:GET:b"), keys(ops));
    }
}
