package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.Model.ModuleEntry;
import com.atlassian.labs.restbrowser.catalog.Model.Operation;
import com.atlassian.labs.restbrowser.catalog.Model.OperationSpec;
import com.atlassian.labs.restbrowser.catalog.Model.Param;
import com.atlassian.labs.restbrowser.catalog.Model.State;
import org.junit.Test;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

/**
 * Compares the index and the (non-admin) summary of a fixed snapshot with the golden files in
 * src/test/resources/catalog/. The frontend's golden.test.ts reads the same files, so the two sides cannot drift.
 * <p>
 * To regenerate the files after an intended format change, run
 * {@code mvn test -Dtest=GoldenCatalogTest -Drab.golden.update=true} (the system property is passed on to the test
 * JVM by the surefire configuration of the build; otherwise use {@code -DargLine=-Drab.golden.update=true}), then
 * review and commit the diff.
 */
public class GoldenCatalogTest {

    private static final Path DIR = Paths.get("src/test/resources/catalog");

    static CatalogSnapshot fixed() {
        ModuleEntry jira = new ModuleEntry("com.atlassian.jira.rest:v2-rest-api", "api/2", "product", "supported",
                "jersey", State.ok, null, null, 4, "com.atlassian.jira.rest", "Jira REST Plugin", "1001.0.0");
        ModuleEntry app = new ModuleEntry("com.example.app:rest", "example/1.0", "user", "app", "jersey",
                State.failed, "timeout", "No answer within 30000 ms (<secret> \"x\")", 0, "com.example.app",
                "Example App é", "2.3.4");
        List<Operation> ops = List.of(
                new Operation("com.atlassian.jira.rest:v2-rest-api:GET:issue/{}",
                        "com.atlassian.jira.rest:v2-rest-api",
                        new OperationSpec("GET", "issue/{issueIdOrKey}", List.of(),
                                List.of("application/json"),
                                List.of(new Param("issueIdOrKey", "path", "string", true, null, null, false),
                                        new Param("fields", "query", "string", false, null, null, true),
                                        new Param("expand", "query", "string", false, "names",
                                                List.of("names", "schema", "renderedFields"), false),
                                        new Param("X-Atlassian-Token", "header", "string", false, null, null,
                                                false),
                                        new Param("rev", "matrix", "int", false, "0", null, false)),
                                "read", false, null)),
                new Operation("com.atlassian.jira.rest:v2-rest-api:POST:issue",
                        "com.atlassian.jira.rest:v2-rest-api",
                        new OperationSpec("POST", "issue", List.of("application/json"),
                                List.of("application/json"),
                                List.of(new Param("updateHistory", "query", "boolean", false, "false", null, false)),
                                "write", false, "com.atlassian.jira.rest.v2.issue.IssueUpdateBean")),
                new Operation("com.atlassian.jira.rest:v2-rest-api:DELETE:issue/{}/watchers",
                        "com.atlassian.jira.rest:v2-rest-api",
                        new OperationSpec("DELETE", "issue/{issueIdOrKey}/watchers", List.of(), List.of(),
                                List.of(new Param("issueIdOrKey", "path", "string", true, null, null, false),
                                        new Param("username", "query", "string", true, null, null, false)),
                                "admin", true, null)),
                new Operation("com.atlassian.jira.rest:v2-rest-api:POST:issue/{}/attachments",
                        "com.atlassian.jira.rest:v2-rest-api",
                        new OperationSpec("POST", "issue/{issueIdOrKey}/attachments",
                                List.of("multipart/form-data", "application/json"), List.of("application/json"),
                                List.of(new Param("issueIdOrKey", "path", "string", true, null, null, false),
                                        new Param("file", "form", "File", true, null, null, true)),
                                null, false, "MultiPart")));
        return CatalogTestSupport.snapshot(List.of(jira, app), ops, true, "4.1.3-SNAPSHOT");
    }

    @Test
    public void indexMatchesGoldenFile() throws IOException {
        compare("golden-index.json", new String(fixed().index(), UTF_8));
    }

    @Test
    public void summaryMatchesGoldenFile() throws IOException {
        compare("golden-summary.json",
                fixed().summary("Jira", "10.3.0", "10030000", "http://localhost:2990/jira", false));
    }

    private static void compare(String name, String actual) throws IOException {
        if (Boolean.getBoolean("rab.golden.update")) {
            Files.createDirectories(DIR);
            Files.writeString(DIR.resolve(name), actual, UTF_8);
            return;
        }
        try (InputStream in = GoldenCatalogTest.class.getResourceAsStream("/catalog/" + name)) {
            assertNotNull(name + " is missing; generate it with -Drab.golden.update=true", in);
            assertEquals(new String(in.readAllBytes(), UTF_8), actual);
        }
    }
}
