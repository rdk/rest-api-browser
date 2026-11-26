package com.atlassian.labs.restbrowser.rest;

import com.atlassian.labs.restbrowser.catalog.CatalogService;
import com.atlassian.labs.restbrowser.catalog.OperationDetails;
import com.atlassian.labs.restbrowser.catalog.OperationSource;
import com.atlassian.labs.restbrowser.catalog.CatalogSnapshot;
import com.atlassian.labs.restbrowser.catalog.CatalogTestSupport;
import com.atlassian.labs.restbrowser.catalog.Model.ModuleEntry;
import com.atlassian.labs.restbrowser.catalog.Model.Operation;
import com.atlassian.labs.restbrowser.catalog.Model.State;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.UrlMode;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.core.StreamingOutput;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

public class CatalogResourceTest {

    private static final String ANONYMOUS = "rest.api.browser.anonymous";

    private final CatalogService catalog = mock(CatalogService.class);
    private final UserManager userManager = mock(UserManager.class);
    private final ApplicationProperties props = mock(ApplicationProperties.class);
    private final HttpServletRequest request = mock(HttpServletRequest.class);
    private final OperationDetails details = mock(OperationDetails.class);
    private final OperationSource source = mock(OperationSource.class);
    private final UserKey user = new UserKey("user");
    private CatalogSnapshot snapshot;
    private CatalogResource resource;
    private String previousAnonymous;

    @Before
    public void setUp() {
        previousAnonymous = System.getProperty(ANONYMOUS);
        System.clearProperty(ANONYMOUS);
        snapshot = snapshot(true);
        when(catalog.current(any())).thenAnswer(i -> snapshot);
        when(props.getDisplayName()).thenReturn("Jira");
        when(props.getVersion()).thenReturn("10.3.0");
        when(props.getBuildNumber()).thenReturn("1");
        when(props.getBaseUrl(UrlMode.RELATIVE)).thenReturn("/jira");
        resource = new CatalogResource(catalog, userManager, props, details, source);
    }

    @After
    public void tearDown() {
        if (previousAnonymous == null) {
            System.clearProperty(ANONYMOUS);
        } else {
            System.setProperty(ANONYMOUS, previousAnonymous);
        }
    }

    private static CatalogSnapshot snapshot(boolean complete) {
        ModuleEntry m = CatalogTestSupport.module("a", "api/1", State.ok, "1.0");
        return CatalogTestSupport.snapshot(List.of(m),
                List.of(new Operation("a:GET:x", "a", CatalogTestSupport.spec("GET", "x"))), complete, "1.0.0");
    }

    private void login(boolean admin, boolean sysadmin) {
        when(userManager.getRemoteUserKey(request)).thenReturn(user);
        when(userManager.isLicensed(user)).thenReturn(true);
        when(userManager.isAdmin(user)).thenReturn(admin || sysadmin);
        when(userManager.isSystemAdmin(user)).thenReturn(sysadmin);
    }

    private String env() {
        return CatalogResource.envTag("Jira", "10.3.0", "1", "/jira");
    }

    @Test
    public void summaryNeedsALogin() {
        Response r = resource.summary(request);
        assertEquals(401, r.getStatus());
        assertEquals("no-store", r.getHeaderString("Cache-Control"));
        verify(catalog, never()).current(any());
    }

    @Test
    public void indexNeedsALogin() {
        assertEquals(401, resource.index(snapshot.hash(), request).getStatus());
    }

    @Test
    public void anonymousIsRefusedEvenWithTheSystemProperty() {
        // the property opens the classic page only; the catalog lists every endpoint and app
        System.setProperty(ANONYMOUS, "true");
        Response r = resource.summary(request);
        assertEquals(401, r.getStatus());
    }

    @Test
    public void unlicensedLoggedInUserIsForbidden() {
        when(userManager.getRemoteUserKey(request)).thenReturn(user);
        when(userManager.isLicensed(user)).thenReturn(false);
        when(userManager.isAdmin(user)).thenReturn(false);
        when(userManager.isSystemAdmin(user)).thenReturn(false);
        assertEquals(403, resource.summary(request).getStatus());
        assertEquals(403, resource.index(snapshot.hash(), request).getStatus());
        when(request.getHeader("X-Atlassian-Token")).thenReturn("no-check");
        assertEquals(403, resource.started("a", request).getStatus());
        verify(catalog, never()).current(any());
    }

    @Test
    public void summaryForANonAdminHasUserEtag() {
        login(false, false);
        Response r = resource.summary(request);
        assertEquals(200, r.getStatus());
        assertEquals("\"" + snapshot.hash() + "-c1.1-" + env() + "-u\"", r.getHeaderString("ETag"));
        assertEquals("private, no-cache", r.getHeaderString("Cache-Control"));
        assertTrue(((String) r.getEntity()).contains("\"admin\":false"));
        assertTrue(((String) r.getEntity()).contains("\"baseUrl\":\"/jira\""));
    }

    @Test
    public void summaryForAnAdminHasAdminEtag() {
        login(true, false);
        Response r = resource.summary(request);
        assertEquals(200, r.getStatus());
        assertEquals("\"" + snapshot.adminTag() + "-c1.1-" + env() + "-a\"", r.getHeaderString("ETag"));
        assertTrue(snapshot.adminTag().matches(snapshot.hash() + "-[0-9a-f]{8}"));
        assertTrue(((String) r.getEntity()).contains("\"admin\":true"));
        assertTrue(((String) r.getEntity()).contains("\"sysadmin\":false"));
    }

    @Test
    public void summaryForASystemAdminHasItsOwnEtag() {
        login(true, true);
        Response r = resource.summary(request);
        assertEquals("\"" + snapshot.adminTag() + "-c1.1-" + env() + "-s\"", r.getHeaderString("ETag"));
        assertTrue(((String) r.getEntity()).contains("\"sysadmin\":true"));
    }

    @Test
    public void aSystemAdminWhoIsNoAdminSeesTheAdminSummaryUnderTheSystemAdminEtag() {
        // the product may make a user system administrator without making them administrator
        when(userManager.getRemoteUserKey(request)).thenReturn(user);
        when(userManager.isAdmin(user)).thenReturn(false);
        when(userManager.isSystemAdmin(user)).thenReturn(true);
        Response r = resource.summary(request);
        assertEquals("\"" + snapshot.adminTag() + "-c1.1-" + env() + "-s\"", r.getHeaderString("ETag"));
        assertTrue(((String) r.getEntity()).contains("\"admin\":true"));
        assertTrue(((String) r.getEntity()).contains("\"sysadmin\":true"));
        when(request.getHeader("If-None-Match")).thenReturn("\"" + snapshot.hash() + "-c1.1-" + env() + "-u\"");
        assertEquals(200, resource.summary(request).getStatus()); // an ordinary user's copy does not match
    }

    @Test
    public void summaryEtagChangesWhenBaseUrlOrSiteTitleChanges() {
        login(false, false);
        String first = resource.summary(request).getHeaderString("ETag");
        when(props.getBaseUrl(UrlMode.RELATIVE)).thenReturn("/jira2");
        when(request.getHeader("If-None-Match")).thenReturn(first);
        Response r = resource.summary(request);
        assertEquals(200, r.getStatus());
        assertNotEquals(first, r.getHeaderString("ETag"));
        assertTrue(r.getHeaderString("ETag").endsWith("-u\""));
    }

    @Test
    public void theTagComesFromBothFlags() {
        String u = CatalogResource.tag(snapshot, false, false);
        String a = CatalogResource.tag(snapshot, true, false);
        String s = CatalogResource.tag(snapshot, true, true);
        String sysadminOnly = CatalogResource.tag(snapshot, false, true);
        assertEquals(4, java.util.Set.of(u, a, s, sysadminOnly).size());
        assertTrue(u.startsWith(snapshot.hash() + "-c1.1-"));
        assertTrue(a.startsWith(snapshot.adminTag() + "-"));
    }

    @Test
    public void matchesAcceptsTheUsualForms() {
        assertTrue(CatalogResource.matches("abc-u", "abc-u"));
        assertTrue(CatalogResource.matches("\"abc-u\"", "abc-u"));
        assertTrue(CatalogResource.matches("W/\"abc-u\"", "abc-u"));
        assertTrue(CatalogResource.matches("\"abc-u-gzip\"", "abc-u"));
        assertTrue(CatalogResource.matches("\"x\", W/\"abc-u\" , \"y\"", "abc-u"));
        assertTrue(CatalogResource.matches("*", "abc-u"));
        assertFalse(CatalogResource.matches("\"abc-a\"", "abc-u"));
        assertFalse(CatalogResource.matches("\"x\", \"y\"", "abc-u"));
        assertFalse(CatalogResource.matches(null, "abc-u"));
    }

    @Test
    public void summaryAnswers304WhenTheEtagMatches() {
        login(false, false);
        String expected = "\"" + snapshot.hash() + "-c1.1-" + env() + "-u\"";
        when(request.getHeader("If-None-Match")).thenReturn(expected);
        Response r = resource.summary(request);
        assertEquals(304, r.getStatus());
        assertEquals(expected, r.getHeaderString("ETag"));
        assertNull(r.getEntity());
    }

    @Test
    public void anAdminsEtagDoesNotMatchAUsersCache() {
        login(true, false);
        when(request.getHeader("If-None-Match")).thenReturn("\"" + snapshot.hash() + "-c1.1-u\"");
        assertEquals(200, resource.summary(request).getStatus());
    }

    @Test
    public void theSummaryEtagFollowsTheProgressOfARebuild() {
        // a rebuild of an unchanged catalog keeps its hash while the modules are read again
        List<ModuleEntry> modules = List.of(CatalogTestSupport.module("a", "api/1", State.ok, "1.0"),
                CatalogTestSupport.module("b", "api/2", State.ok, "1.0"));
        CatalogSnapshot started = CatalogTestSupport.snapshot(modules, List.of(), false, 0, 2, "1.0.0");
        CatalogSnapshot halfway = CatalogTestSupport.snapshot(modules, List.of(), false, 1, 2, "1.0.0");
        CatalogSnapshot finished = CatalogTestSupport.snapshot(modules, List.of(), true, 2, 2, "1.0.0");
        assertEquals(started.hash(), halfway.hash());
        for (boolean admin : new boolean[]{false, true}) {
            login(admin, false);
            when(request.getHeader("If-None-Match")).thenReturn(null);
            snapshot = started;
            String first = resource.summary(request).getHeaderString("ETag");
            when(request.getHeader("If-None-Match")).thenReturn(first);
            assertEquals(304, resource.summary(request).getStatus());
            snapshot = halfway;
            Response r = resource.summary(request);
            assertEquals(200, r.getStatus());
            assertTrue(((String) r.getEntity()).contains("\"progress\":{\"done\":1,\"total\":2}"));
            String second = r.getHeaderString("ETag");
            assertNotEquals(first, second);
            when(request.getHeader("If-None-Match")).thenReturn(second);
            snapshot = finished;
            assertEquals(200, resource.summary(request).getStatus());
        }
        assertEquals("p1.2", CatalogResource.progress(halfway));
        assertEquals("c2.2", CatalogResource.progress(finished));
    }

    @Test
    public void completeIndexIsImmutable() throws Exception {
        login(false, false);
        Response r = resource.index(snapshot.hash(), request);
        assertEquals(200, r.getStatus());
        assertEquals("private, max-age=31536000, immutable", r.getHeaderString("Cache-Control"));
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ((StreamingOutput) r.getEntity()).write(out);
        assertEquals(new String(snapshot.index(), StandardCharsets.UTF_8), out.toString(StandardCharsets.UTF_8));
        assertEquals(snapshot.index().length, r.getMetadata().getFirst("Content-Length"));
    }

    @Test
    public void incompleteIndexIsNotCached() {
        login(false, false);
        snapshot = snapshot(false);
        Response r = resource.index(snapshot.hash(), request);
        assertEquals(200, r.getStatus());
        assertEquals("private, no-cache", r.getHeaderString("Cache-Control"));
    }

    @Test
    public void indexOfAnotherHashIs404WithNoStore() {
        login(false, false);
        Response r = resource.index("0123456789abcdef01234567", request);
        assertEquals(404, r.getStatus());
        assertEquals("no-store", r.getHeaderString("Cache-Control"));
        assertTrue(((String) r.getEntity()).contains(snapshot.hash()));
    }

    @Test
    public void refreshIsForbiddenForANonSystemAdmin() {
        login(true, false);
        when(request.getHeader("X-Atlassian-Token")).thenReturn("no-check");
        Response r = resource.refresh(null, request);
        assertEquals(403, r.getStatus());
        assertEquals("no-store", r.getHeaderString("Cache-Control"));
        verify(catalog, never()).refresh(any());
    }

    @Test
    public void refreshWithoutAUserAsksForALogin() {
        // an expired session: the UI sends the user to log in again instead of saying they lack a permission
        when(request.getHeader("X-Atlassian-Token")).thenReturn("no-check");
        Response r = resource.refresh(null, request);
        assertEquals(401, r.getStatus());
        assertEquals("{\"error\":\"login-required\"}", r.getEntity());
        assertEquals("no-store", r.getHeaderString("Cache-Control"));
        verify(catalog, never()).refresh(any());
    }

    @Test
    public void refreshIsForbiddenWithoutTheXsrfHeader() {
        login(true, true);
        Response r = resource.refresh(null, request);
        assertEquals(403, r.getStatus());
        assertTrue(((String) r.getEntity()).contains("xsrf"));
        assertEquals("no-store", r.getHeaderString("Cache-Control"));
        verify(catalog, never()).refresh(any());
    }

    @Test
    public void refreshOfEverythingAnswers204() {
        login(true, true);
        when(request.getHeader("X-Atlassian-Token")).thenReturn("no-check");
        assertEquals(204, resource.refresh(null, request).getStatus());
        verify(catalog).refresh(null);
        assertEquals(204, resource.refresh("  ", request).getStatus());
    }

    @Test
    public void detailsAreForSystemAdminsOnly() {
        login(true, false);
        assertEquals(403, resource.details("a:b:GET:x", request).getStatus());
        verify(details, never()).describe(any());
    }

    @Test
    public void detailsWithoutAUserAskForALogin() {
        Response r = resource.details("a:b:GET:x", request);
        assertEquals(401, r.getStatus());
        assertEquals("{\"error\":\"login-required\"}", r.getEntity());
        assertEquals("no-store", r.getHeaderString("Cache-Control"));
        verify(details, never()).describe(any());
    }

    @Test
    public void detailsPassTheStatusAndBodyOn() {
        login(true, true);
        when(details.describe("a:b:GET:x")).thenReturn(new OperationDetails.Result(404, "{\"error\":\"unknown-operation\"}"));
        Response r = resource.details("a:b:GET:x", request);
        assertEquals(404, r.getStatus());
        assertEquals("{\"error\":\"unknown-operation\"}", r.getEntity());
        assertEquals("no-store", r.getHeaderString("Cache-Control"));
    }

    @Test
    public void detailsSourceIsForSystemAdminsOnly() {
        assertEquals(401, resource.detailsSource("a:b:GET:x", null, null, null, null, request).getStatus());
        login(true, false);
        assertEquals(403, resource.detailsSource("a:b:GET:x", null, null, null, null, request).getStatus());
        verify(source, never()).decompile(any(), any(), org.mockito.ArgumentMatchers.anyLong(), any(), any());
        login(true, true);
        when(source.decompile("a:b:GET:x", "com.example.Foo", 42L, "class", "vineflower"))
                .thenReturn(new OperationDetails.Result(200, "{\"source\":\"class Foo {}\"}"));
        Response r = resource.detailsSource("a:b:GET:x", "com.example.Foo", 42L, "class", "vineflower", request);
        assertEquals(200, r.getStatus());
        assertEquals("no-store", r.getHeaderString("Cache-Control"));
        assertTrue(((String) r.getEntity()).contains("class Foo"));
    }

    private static CatalogSnapshot withModules(ModuleEntry... modules) {
        return CatalogTestSupport.snapshot(List.of(modules), List.of(), true, "1.0.0");
    }

    private static ModuleEntry failedModule(String id, String reason) {
        return new ModuleEntry(id, "x/1", "product", "internal", null, State.failed, reason, "details", 0, "p", "P", "1");
    }

    @Test
    public void startedReadsAModuleThatHadNotStartedAgainAndSaysHow() {
        login(false, false); // any licensed user
        when(request.getHeader("X-Atlassian-Token")).thenReturn("no-check");
        snapshot = withModules(failedModule("p:waiting", "not-started"));
        ModuleEntry read = CatalogTestSupport.module("p:waiting", "x/1", State.ok, "1.0");
        when(catalog.readStarted("p:waiting", CatalogResource.STARTED_WAIT_MS))
                .thenReturn(new CatalogService.Started(CatalogService.StartOutcome.READ, read));
        Response r = resource.started("p:waiting", request);
        assertEquals(200, r.getStatus());
        assertEquals("no-store", r.getHeaderString("Cache-Control"));
        assertEquals("{\"state\":\"ok\",\"reason\":null,\"opCount\":" + read.opCount() + "}", r.getEntity());
        verify(catalog, never()).refresh(any()); // the catalog is not marked incomplete
    }

    @Test
    public void startedAnswersEachOutcomeOfTheRead() {
        login(false, false);
        when(request.getHeader("X-Atlassian-Token")).thenReturn("no-check");
        snapshot = withModules(failedModule("p:waiting", "not-started"));
        when(catalog.readStarted(any(), org.mockito.ArgumentMatchers.anyLong()))
                .thenReturn(new CatalogService.Started(CatalogService.StartOutcome.STILL_NOT_STARTED, null))
                .thenReturn(new CatalogService.Started(CatalogService.StartOutcome.QUEUED, null))
                .thenReturn(new CatalogService.Started(CatalogService.StartOutcome.UNKNOWN, null))
                .thenReturn(new CatalogService.Started(CatalogService.StartOutcome.FAILED, null));
        Response still = resource.started("p:waiting", request);
        assertEquals(409, still.getStatus());
        assertEquals("{\"error\":\"still-not-started\"}", still.getEntity());
        assertEquals(202, resource.started("p:waiting", request).getStatus());
        assertEquals(404, resource.started("p:waiting", request).getStatus());
        Response failed = resource.started("p:waiting", request);
        assertEquals(500, failed.getStatus());
        assertEquals("{\"error\":\"read-failed\"}", failed.getEntity());
    }

    @Test
    public void startedDoesNothingForAModuleThatIsDescribedPendingOrFailedForAnotherReason() {
        login(false, false);
        when(request.getHeader("X-Atlassian-Token")).thenReturn("no-check");
        ModuleEntry pending = new ModuleEntry("p:pending", "x/1", "product", "internal", null, State.pending, null, null, 0, "p", "P", "1");
        snapshot = withModules(CatalogTestSupport.module("p:ok", "ok/1", State.ok, "1.0"), failedModule("p:excluded", "excluded"), pending);
        assertEquals(204, resource.started("p:ok", request).getStatus());
        assertEquals(202, resource.started("p:pending", request).getStatus()); // being read anyway
        Response other = resource.started("p:excluded", request);
        assertEquals(409, other.getStatus());
        assertEquals("{\"error\":\"not-waiting-to-start\"}", other.getEntity());
        assertEquals(404, resource.started("p:none", request).getStatus());
        assertEquals(404, resource.started(null, request).getStatus());
        verify(catalog, never()).readStarted(any(), org.mockito.ArgumentMatchers.anyLong());
    }

    @Test
    public void entryJsonKeepsOnlySafeCharactersOfTheReason() {
        ModuleEntry e = new ModuleEntry("p:x", "x/1", "product", "internal", null, State.failed, "model-unavailable\"<x>", "e", 0, "p", "P", "1");
        assertEquals("{\"state\":\"failed\",\"reason\":\"model-unavailablex\",\"opCount\":0}", CatalogResource.entryJson(e));
    }

    @Test
    public void startedNeedsALoginAndTheXsrfHeader() {
        snapshot = withModules(failedModule("p:waiting", "not-started"));
        when(request.getHeader("X-Atlassian-Token")).thenReturn("no-check");
        assertEquals(401, resource.started("p:waiting", request).getStatus());
        login(false, false);
        when(request.getHeader("X-Atlassian-Token")).thenReturn(null);
        Response r = resource.started("p:waiting", request);
        assertEquals(403, r.getStatus());
        assertTrue(((String) r.getEntity()).contains("xsrf"));
        verify(catalog, never()).readStarted(any(), org.mockito.ArgumentMatchers.anyLong());
    }

    @Test
    public void refreshOfOneModule() {
        login(true, true);
        when(request.getHeader("X-Atlassian-Token")).thenReturn("no-check");
        assertEquals(204, resource.refresh("a:b", request).getStatus());
        verify(catalog).refresh("a:b");
    }
}
