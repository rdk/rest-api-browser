package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.CatalogQuery.OperationFilter;
import com.atlassian.labs.restbrowser.catalog.Model.ModuleEntry;
import com.atlassian.labs.restbrowser.catalog.Model.Operation;
import com.atlassian.labs.restbrowser.catalog.Model.OperationSpec;
import com.atlassian.labs.restbrowser.catalog.Model.Param;
import com.atlassian.labs.restbrowser.catalog.Model.State;
import com.atlassian.labs.restbrowser.json.JsonParser;
import org.junit.Before;
import org.junit.Test;

import java.util.List;
import java.util.Map;

import static org.junit.Assert.*;

public class CatalogQueryTest {

    private CatalogSnapshot snapshot;

    @Before
    public void setUp() {
        ModuleEntry m1 = new ModuleEntry("api2", "api/2", "product", "supported", "jersey", State.ok,
                null, null, 5, "plugin.tracker", "Tracker Plugin", "1.0");
        ModuleEntry m2 = new ModuleEntry("pub1", "public/1", "product", "experimental", "jersey", State.ok,
                null, null, 1, "plugin.pub", "Public Plugin", "1.0");

        Operation getIssue = new Operation("api2:GET:issue/{id}", "api2",
                new OperationSpec("GET", "issue/{id}", List.of(), List.of("application/json"),
                        List.of(new Param("id", "path", "string", true, null, List.of(), false, "Issue key", "java.lang.String")),
                        "LicensedOnly", false, null, "Get issue by ID", "Returns full issue representation",
                        null, "IssueDto", "com.example.IssueDto"));

        Operation getComments = new Operation("api2:GET:issue/{id:[0-9]+}/comments", "api2",
                new OperationSpec("GET", "issue/{id:[0-9]+}/comments", List.of(), List.of("application/json"),
                        List.of(new Param("id", "path", "integer", true, null, List.of(), false, null, "java.lang.Long")),
                        "LicensedOnly", false, null, "List issue comments", null,
                        null, "List", "java.util.List<com.example.CommentDto>"));

        Operation createIssue = new Operation("api2:POST:issue", "api2",
                new OperationSpec("POST", "issue", List.of("application/json"), List.of("application/json"),
                        List.of(), "AdminOnly", false, "CreateIssueReq", "Create issue", null,
                        "com.example.CreateIssueReq", "IssueDto", "com.example.IssueDto"));

        Operation oldDelete = new Operation("api2:DELETE:old/{path:.*}", "api2",
                new OperationSpec("DELETE", "old/{path:.*}", List.of(), List.of(),
                        List.of(new Param("path", "path", "string", true, null, List.of(), false)),
                        "SystemAdminOnly", true, null, "Deprecated delete catch-all", null,
                        null, null, null));

        Operation mixedItem = new Operation("api2:GET:item-{code}.json", "api2",
                new OperationSpec("GET", "item-{code}.json", List.of(), List.of("application/json"),
                        List.of(new Param("code", "path", "string", true, null, List.of(), false)),
                        "LicensedOnly", false, null, "Fetch JSON item", null,
                        null, null, null));

        Operation pubStatus = new Operation("pub1:GET:status", "pub1",
                new OperationSpec("GET", "status", List.of(), List.of("application/json"),
                        List.of(), "AnonymousSiteAccess", false, null, "Public health status", null,
                        null, null, null));

        snapshot = CatalogTestSupport.snapshot(
                List.of(m1, m2),
                List.of(getIssue, getComments, createIssue, oldDelete, mixedItem, pubStatus),
                true, "1.0.0");
    }

    @Test
    @SuppressWarnings("unchecked")
    public void searchesFiltersScoresAndPaginates() {
        String raw = CatalogQuery.searchJson(snapshot,
                new OperationFilter("issue", "GET,POST", "/rest/api/2", null, "plugin.tracker",
                        null, false, null, 2, 0, false));
        Map<String, Object> res = JsonParser.parseObject(raw);
        assertEquals(3L, res.get("totalMatches"));
        assertEquals(2L, res.get("limit"));
        assertEquals(0L, res.get("offset"));
        assertEquals(Boolean.TRUE, res.get("truncated"));
        List<Map<String, Object>> ops = (List<Map<String, Object>>) res.get("operations");
        assertEquals(2, ops.size());

        // Word-boundary check on usesClass: CommentDto matches api2:GET:issue/{id:[0-9]+}/comments
        Map<String, Object> byClass = JsonParser.parseObject(CatalogQuery.searchJson(snapshot,
                new OperationFilter(null, null, null, null, null, null, null, "CommentDto", 10, 0, true)));
        assertEquals(1L, byClass.get("totalMatches"));
        List<Map<String, Object>> classOps = (List<Map<String, Object>>) byClass.get("operations");
        Map<String, Object> nestedOp = (Map<String, Object>) classOps.get(0).get("operation");
        assertEquals("api2:GET:issue/{id:[0-9]+}/comments", nestedOp.get("key"));

        // Anonymous access & deprecated filters
        Map<String, Object> anon = JsonParser.parseObject(CatalogQuery.searchJson(snapshot,
                new OperationFilter(null, null, null, null, null, "anonymous", null, null, 10, 0, false)));
        assertEquals(1L, anon.get("totalMatches"));

        Map<String, Object> dep = JsonParser.parseObject(CatalogQuery.searchJson(snapshot,
                new OperationFilter(null, null, null, null, null, "sysadmin", true, null, 10, 0, false)));
        assertEquals(1L, dep.get("totalMatches"));

        String md = CatalogQuery.searchMarkdown(snapshot,
                new OperationFilter("status", null, null, null, null, null, null, null, 10, 0, false));
        assertTrue(md.contains("# Catalog Operations"));
        assertTrue(md.contains("public/1/status"));
    }

    @Test
    @SuppressWarnings("unchecked")
    public void resolvesFullAndRelativeUrlsWithPathAndQueryParams() {
        Map<String, Object> res = JsonParser.parseObject(CatalogQuery.resolveUrlJson(
                snapshot, null, "https://example.test/ctx/rest/api/2/issue/42/comments?expand=author&limit=10", 5));
        assertEquals(1L, res.get("matchCount"));
        Map<String, Object> input = (Map<String, Object>) res.get("input");
        assertEquals("api/2/issue/42/comments", input.get("normalizedPath"));
        Map<String, Object> qp = (Map<String, Object>) input.get("queryParams");
        assertEquals(List.of("author"), qp.get("expand"));
        Map<String, Object> m0 = ((List<Map<String, Object>>) res.get("matches")).get(0);
        assertEquals("api2:GET:issue/{id:[0-9]+}/comments", m0.get("key"));
        assertEquals("42", ((Map<String, Object>) m0.get("pathParams")).get("id"));

        // Regex {id:[0-9]+} rejects non-numeric segment
        Map<String, Object> nonNumeric = JsonParser.parseObject(CatalogQuery.resolveUrlJson(
                snapshot, "GET", "/rest/api/2/issue/abc/comments", 5));
        assertEquals(0L, nonNumeric.get("matchCount"));

        // Catch-all {path:.*}
        Map<String, Object> catchAll = JsonParser.parseObject(CatalogQuery.resolveUrlJson(
                snapshot, "DELETE", "api/2/old/a/b/c", 5));
        assertEquals(1L, catchAll.get("matchCount"));
        Map<String, Object> caMatch = ((List<Map<String, Object>>) catchAll.get("matches")).get(0);
        assertEquals("a/b/c", ((Map<String, Object>) caMatch.get("pathParams")).get("path"));

        // Mixed literal + variable segment item-{code}.json
        Map<String, Object> mixed = JsonParser.parseObject(CatalogQuery.resolveUrlJson(
                snapshot, "GET", "/rest/api/2/item-alpha.json", 5));
        assertEquals(1L, mixed.get("matchCount"));
        Map<String, Object> mixMatch = ((List<Map<String, Object>>) mixed.get("matches")).get(0);
        assertEquals("alpha", ((Map<String, Object>) mixMatch.get("pathParams")).get("code"));

        String md = CatalogQuery.resolveUrlMarkdown(snapshot, "GET", "/rest/api/2/issue/ABC-1", 5);
        assertTrue(md.contains("# URL Resolution"));
        assertTrue(md.contains("api2:GET:issue/{id}"));
    }
}
