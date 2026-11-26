package com.atlassian.labs.restbrowser.inspect;

import com.atlassian.labs.restbrowser.decompile.DecompilerEngine;
import com.atlassian.labs.restbrowser.decompile.LineSlicer;
import com.atlassian.labs.restbrowser.inspect.ClassFileInspector.ClassHierarchy;
import com.atlassian.labs.restbrowser.inspect.ClassFileInspector.MethodOutline;
import com.atlassian.labs.restbrowser.inspect.ClassGraphTraverser.GraphResult;
import com.atlassian.labs.restbrowser.inspect.ClassGraphTraverser.ResolvedClassInfo;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiBytecodeScanner;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiImplementationFinder;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiImplementationFinder.ImplHit;
import com.atlassian.labs.restbrowser.rest.RestAuth;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.ws.rs.core.Response;
import org.junit.Test;
import org.mockito.Mockito;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.InputStream;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.Assert.*;

public class AgentBytecodeAndGraphTest {

    public interface Contract {
        String work();
    }

    public static abstract class BaseContract implements Contract {
    }

    public static class ConcreteContract extends BaseContract {
        private static final String MARKER = "agent-marker-literal-42";

        @Override
        public String work() {
            return helper() + MARKER;
        }

        private String helper() {
            return "ok:";
        }
    }

    public static class CallerWithLibs {
        private static final Logger LOG = LoggerFactory.getLogger(CallerWithLibs.class);

        public Response invoke(ConcreteContract c) {
            LOG.debug("calling");
            return Response.ok(c.work()).build();
        }
    }

    private static byte[] bytesOf(Class<?> c) throws Exception {
        try (InputStream in = c.getClassLoader().getResourceAsStream(c.getName().replace('.', '/') + ".class")) {
            assertNotNull("classfile bytes for " + c.getName(), in);
            return in.readAllBytes();
        }
    }

    @Test
    public void bundlePathToClassNameFiltersUnsafeAndMetaEntries() {
        assertEquals("com.example.Foo", ClassFileInspector.bundlePathToClassName("/com/example/Foo.class"));
        assertEquals("com.example.Foo", ClassFileInspector.bundlePathToClassName("WEB-INF/classes/com/example/Foo.class"));
        assertNull(ClassFileInspector.bundlePathToClassName("/META-INF/versions/17/com/example/Foo.class"));
        assertNull(ClassFileInspector.bundlePathToClassName("/com/example/module-info.class"));
        assertNull(ClassFileInspector.bundlePathToClassName("/com/example/package-info.class"));
        assertNull(ClassFileInspector.bundlePathToClassName("/com/example/../Evil.class"));
    }

    @Test
    public void hierarchyAndImplementationMatcherFindsDirectAndTransitiveSubtypes() throws Exception {
        ClassHierarchy iface = ClassFileInspector.readHierarchy(bytesOf(Contract.class));
        ClassHierarchy base = ClassFileInspector.readHierarchy(bytesOf(BaseContract.class));
        ClassHierarchy impl = ClassFileInspector.readHierarchy(bytesOf(ConcreteContract.class));
        assertNotNull(iface);
        assertNotNull(base);
        assertNotNull(impl);
        assertTrue(iface.isInterface());
        assertTrue(base.isAbstract());
        assertFalse(impl.isAbstract());
        assertEquals(BaseContract.class.getName(), impl.superName());

        Map<String, ClassHierarchy> map = new LinkedHashMap<>();
        map.put(iface.name(), iface);
        map.put(base.name(), base);
        map.put(impl.name(), impl);

        List<ImplHit> concreteOnly = OsgiImplementationFinder.matchHierarchies(
                Contract.class.getName(), map, 12L, "test-bundle", "test-plugin", false, 10);
        assertEquals(1, concreteOnly.size());
        assertEquals(ConcreteContract.class.getName(), concreteOnly.get(0).fqcn());
        assertTrue(concreteOnly.get(0).via().contains(BaseContract.class.getName()));

        List<ImplHit> withAbstract = OsgiImplementationFinder.matchHierarchies(
                Contract.class.getName(), map, 12L, "test-bundle", "test-plugin", true, 10);
        assertEquals(2, withAbstract.size());

        List<ImplHit> limited = OsgiImplementationFinder.matchHierarchies(
                Contract.class.getName(), map, 12L, "test-bundle", "test-plugin", true, 1);
        assertEquals(1, limited.size());
    }

    @Test
    public void grepAndCallersMatchBytecodeConstantPools() throws Exception {
        byte[] concreteBytes = bytesOf(ConcreteContract.class);
        List<String> ciHits = OsgiBytecodeScanner.matchStrings(concreteBytes, "AGENT-MARKER", false, true);
        assertTrue("hits=" + ciHits, ciHits.contains("agent-marker-literal-42"));
        assertTrue(OsgiBytecodeScanner.matchStrings(concreteBytes, "AGENT-MARKER", true, true).isEmpty());
        assertFalse(OsgiBytecodeScanner.matchStrings(concreteBytes, "agent-marker", true, false).isEmpty());

        byte[] callerBytes = bytesOf(CallerWithLibs.class);
        List<String> calls = OsgiBytecodeScanner.matchCalls(callerBytes, ConcreteContract.class.getName(), null);
        assertTrue("calls=" + calls, calls.contains("work()Ljava/lang/String;"));
        assertTrue(OsgiBytecodeScanner.matchCalls(callerBytes, ConcreteContract.class.getName(), "missing").isEmpty());
    }

    @Test
    public void excludeLibrariesFiltersFrameworkPackagesAndRetainsDomainCode() throws Exception {
        assertTrue(ClassGraphTraverser.isCommonLibrary("org.slf4j.Logger"));
        assertTrue(ClassGraphTraverser.isCommonLibrary("com.fasterxml.jackson.databind.ObjectMapper"));
        assertTrue(ClassGraphTraverser.isCommonLibrary("org.glassfish.jersey.server.ResourceConfig"));
        assertTrue(ClassGraphTraverser.isStandardJdk("jakarta.ws.rs.core.Response"));
        assertFalse(ClassGraphTraverser.isCommonLibrary("com.atlassian.labs.restbrowser.catalog.CatalogQuery"));

        ClassLoader cl = CallerWithLibs.class.getClassLoader();
        ResolvedClassInfo root = new ResolvedClassInfo(
                CallerWithLibs.class.getName(), CallerWithLibs.class, cl, -1L, 0L, bytesOf(CallerWithLibs.class));

        GraphResult unfiltered = ClassGraphTraverser.traverse(
                root, List.of(cl), (fqcn, loaders) -> null, 1, 20, true, false, "", 5_000L);
        List<String> unfilteredRefs = unfiltered.adjacency().get(CallerWithLibs.class.getName());
        assertTrue("expected framework refs without filter", unfilteredRefs.contains(Logger.class.getName()));
        assertTrue("expected jakarta refs without filter", unfilteredRefs.contains(Response.class.getName()));

        GraphResult filtered = ClassGraphTraverser.traverse(
                root, List.of(cl), (fqcn, loaders) -> null, 1, 20, false, true, "", 5_000L);
        List<String> filteredRefs = filtered.adjacency().get(CallerWithLibs.class.getName());
        assertTrue("domain class kept", filteredRefs.contains(ConcreteContract.class.getName()));
        assertFalse("slf4j excluded", filteredRefs.contains(Logger.class.getName()));
        assertFalse("jakarta.ws.rs excluded", filteredRefs.contains(Response.class.getName()));
        assertTrue(filtered.visited().keySet().stream().noneMatch(ClassGraphTraverser::isCommonLibrary));
    }

    @Test
    public void lineSlicerNumbersAndRestAuthContentNegotiationWork() {
        assertEquals(" 9 | nine\n10 | ten", LineSlicer.formatWithLineNumbers("nine\nten", 9));

        assertTrue(RestAuth.prefersMarkdown("text/markdown"));
        assertTrue(RestAuth.prefersMarkdown("text/markdown;q=0.9, application/json;q=0.5"));
        assertFalse(RestAuth.prefersMarkdown("application/json, text/markdown"));
        assertFalse(RestAuth.prefersMarkdown("text/markdown;q=0, */*;q=0.8"));
        assertFalse(RestAuth.prefersMarkdown("text/html,application/xhtml+xml,*/*;q=0.8"));
        assertTrue(RestAuth.prefersPlainText("text/plain, */*;q=0.8"));
        assertFalse(RestAuth.prefersPlainText("application/json, text/plain, */*"));
    }

    @Test
    public void outlinesTypedEdgesDecompilerWarningsAndEtagHelpersWork() throws Exception {
        byte[] concreteBytes = bytesOf(ConcreteContract.class);
        List<MethodOutline> outlines = ClassFileInspector.readMethodOutlines(concreteBytes);
        MethodOutline work = outlines.stream().filter(m -> "work".equals(m.name())).findFirst().orElse(null);
        assertNotNull(work);
        assertTrue(work.startLine() > 0);
        assertTrue(work.endLine() >= work.startLine());
        assertEquals("work(): String", work.signature());

        byte[] callerBytes = bytesOf(CallerWithLibs.class);
        Map<String, Set<String>> typed = ClassFileInspector.readTypedReferences(callerBytes);
        assertTrue(typed.get(ConcreteContract.class.getName()).contains("signature"));
        assertTrue(typed.get(Logger.class.getName()).contains("field"));

        byte[] baseBytes = bytesOf(BaseContract.class);
        byte[] contractBytes = bytesOf(Contract.class);
        ClassLoader cl = BaseContract.class.getClassLoader();
        ResolvedClassInfo root = new ResolvedClassInfo(BaseContract.class.getName(), BaseContract.class, cl, -1L, 0L, baseBytes);
        GraphResult filteredKinds = ClassGraphTraverser.traverse(
                root,
                List.of(cl),
                (fqcn, loaders) -> Contract.class.getName().equals(fqcn)
                        ? new ResolvedClassInfo(Contract.class.getName(), Contract.class, cl, -1L, 0L, contractBytes)
                        : null,
                1, 10, false, false, "", Set.of("implements"), 5_000L);
        assertEquals(1, filteredKinds.edges().size());
        assertEquals(List.of("implements"),
                filteredKinds.edgeKinds().get(ClassGraphTraverser.edgeKey(BaseContract.class.getName(), Contract.class.getName())));

        assertFalse(DecompilerEngine.detectSourceWarnings("// $VF: Couldn't be decompiled\nclass X {}").isEmpty());
        assertTrue(DecompilerEngine.detectSourceWarnings("class Clean {}").isEmpty());

        HttpServletRequest req = Mockito.mock(HttpServletRequest.class);
        Response ok = RestAuth.cacheableResponse(req, 200, RestAuth.JSON_MEDIA_TYPE, "{\"a\":1}");
        assertEquals(200, ok.getStatus());
        String etag = ok.getHeaderString("ETag");
        assertNotNull(etag);
        Mockito.when(req.getHeader("If-None-Match")).thenReturn("W/" + etag.replace("\"", "\"") + "-gzip");
        // Test standard weak tag match too
        String rawTag = etag.replace("\"", "");
        assertTrue(RestAuth.matchesEtag("W/\"" + rawTag + "-gzip\"", rawTag));
        Response notMod = RestAuth.cacheableResponse(req, 200, RestAuth.JSON_MEDIA_TYPE, "{\"a\":1}");
        assertEquals(304, notMod.getStatus());

        Response err = RestAuth.cacheableResponse(req, 404, RestAuth.JSON_MEDIA_TYPE, "{\"error\":\"x\"}");
        assertEquals(404, err.getStatus());
        assertEquals("no-store", err.getHeaderString("Cache-Control"));
    }
}
