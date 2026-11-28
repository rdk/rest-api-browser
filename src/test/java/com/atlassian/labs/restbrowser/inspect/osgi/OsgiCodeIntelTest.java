package com.atlassian.labs.restbrowser.inspect.osgi;

import com.atlassian.labs.restbrowser.inspect.ClassFileInspector.ClassHierarchy;
import com.atlassian.labs.restbrowser.inspect.ClassGraphTraverser.ResolvedClassInfo;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiImplementationFinder.ImplHit;
import com.atlassian.labs.restbrowser.json.Json;
import org.junit.Test;
import org.osgi.framework.Bundle;
import org.osgi.framework.Version;
import org.osgi.framework.wiring.BundleCapability;
import org.osgi.framework.wiring.BundleRevision;
import org.osgi.framework.wiring.BundleWire;
import org.osgi.framework.wiring.BundleWiring;

import java.io.InputStream;
import java.util.Dictionary;
import java.util.Hashtable;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static com.atlassian.labs.restbrowser.catalog.CatalogTestSupport.parseJson;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Direct unit tests for pure helpers in {@link OsgiBundleInspector}, {@link OsgiBytecodeScanner},
 * {@link OsgiClassResolver}, {@link OsgiClassSearcher}, and {@link OsgiImplementationFinder}.
 */
public class OsgiCodeIntelTest {

    public static final class SampleTarget {
        public static final String CONST = "RabTestMarkerLiteral";

        public String ping(String v) {
            return v == null ? CONST : v;
        }
    }

    public static final class SampleCaller {
        public String callTarget(SampleTarget t) {
            return t.ping("hi");
        }
    }

    private static byte[] bytecodeOf(Class<?> cls) throws Exception {
        try (InputStream in = cls.getClassLoader().getResourceAsStream(cls.getName().replace('.', '/') + ".class")) {
            assertNotNull("class bytes for " + cls.getName(), in);
            return in.readAllBytes();
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    public void bundleInspectorHelpersAndWriteBundleSummaryWorkWithMockBundle() throws Exception {
        assertFalse(OsgiBundleInspector.isScannableState(null));
        assertTrue(OsgiBundleInspector.isScannableState(bundleWithState(Bundle.ACTIVE)));
        assertTrue(OsgiBundleInspector.isScannableState(bundleWithState(Bundle.RESOLVED)));
        assertTrue(OsgiBundleInspector.isScannableState(bundleWithState(Bundle.STARTING)));
        assertFalse(OsgiBundleInspector.isScannableState(bundleWithState(Bundle.INSTALLED)));
        assertFalse(OsgiBundleInspector.isScannableState(bundleWithState(Bundle.UNINSTALLED)));

        assertEquals("ACTIVE", OsgiBundleInspector.state(Bundle.ACTIVE));
        assertEquals("STOPPING", OsgiBundleInspector.state(Bundle.STOPPING));
        assertEquals("1.2.3", OsgiBundleInspector.version(Map.of("version", "1.2.3")));
        assertEquals("", OsgiBundleInspector.version(Map.of()));
        assertEquals("ab…", OsgiBundleInspector.cut("ab\uD83D\uDE00cd", 3));
        assertEquals("short", OsgiBundleInspector.clip("short"));

        Bundle b = mock(Bundle.class);
        when(b.getBundleId()).thenReturn(42L);
        when(b.getSymbolicName()).thenReturn("com.example.plugin");
        when(b.getVersion()).thenReturn(new Version("2.1.0"));
        when(b.getState()).thenReturn(Bundle.ACTIVE);
        when(b.getLocation()).thenReturn("obr://example.jar");
        when(b.getLastModified()).thenReturn(1_700_000_000_000L);
        Dictionary<String, String> headers = new Hashtable<>();
        headers.put("Atlassian-Plugin-Key", "com.example.plugin.key");
        headers.put("Bundle-Vendor", "Example");
        headers.put("Fragment-Host", "host.bundle");
        when(b.getHeaders("")).thenReturn(headers);

        BundleWiring wiring = mock(BundleWiring.class);
        BundleCapability cap = mock(BundleCapability.class);
        when(cap.getAttributes()).thenReturn(Map.of(BundleRevision.PACKAGE_NAMESPACE, "com.example.api"));
        BundleWire prov = mock(BundleWire.class);
        when(prov.getCapability()).thenReturn(cap);
        BundleWire req = mock(BundleWire.class);
        when(wiring.isInUse()).thenReturn(true);
        when(wiring.getCapabilities(BundleRevision.PACKAGE_NAMESPACE)).thenReturn(List.of(cap));
        when(wiring.getProvidedWires(BundleRevision.PACKAGE_NAMESPACE)).thenReturn(List.of(prov));
        when(wiring.getRequiredWires(BundleRevision.PACKAGE_NAMESPACE)).thenReturn(List.of(req, req));
        when(b.adapt(BundleWiring.class)).thenReturn(wiring);

        assertEquals("com.example.plugin 2.1.0", OsgiBundleInspector.bundleLabel(b));
        assertEquals("com.example.plugin.key", OsgiBundleInspector.pluginKey(b, null));
        assertEquals("override.key", OsgiBundleInspector.pluginKey(b, x -> "override.key"));

        Json j = new Json();
        OsgiBundleInspector.writeBundleSummary(j, b, "com.example.api");
        Map<String, Object> summary = (Map<String, Object>) parseJson(j.toString());
        assertEquals(42L, summary.get("id"));
        assertEquals(Boolean.TRUE, summary.get("fragment"));
        assertEquals(2L, summary.get("importCount"));
        assertEquals(1L, summary.get("exportCount"));
        assertEquals(Boolean.TRUE, summary.get("packageExported"));
        assertEquals(1L, summary.get("packageExportUsers"));
    }

    @Test
    public void bytecodeScannerMatchesStringsAndCallsDirectly() throws Exception {
        byte[] targetBytes = bytecodeOf(SampleTarget.class);
        assertEquals(List.of(), OsgiBytecodeScanner.matchStrings(targetBytes, "", false, true));
        assertEquals(List.of("RabTestMarkerLiteral"),
                OsgiBytecodeScanner.matchStrings(targetBytes, "rabtestmarker", false, false));
        assertEquals(List.of(),
                OsgiBytecodeScanner.matchStrings(targetBytes, "rabtestmarker", true, false));
        assertFalse(OsgiBytecodeScanner.matchStrings(targetBytes, "ping", false, true).isEmpty());

        byte[] callerBytes = bytecodeOf(SampleCaller.class);
        List<String> allCalls = OsgiBytecodeScanner.matchCalls(callerBytes, SampleTarget.class.getName(), null);
        assertEquals(List.of("ping(Ljava/lang/String;)Ljava/lang/String;"), allCalls);
        assertEquals(allCalls, OsgiBytecodeScanner.matchCalls(callerBytes, SampleTarget.class.getName(), "ping"));
        assertEquals(List.of(), OsgiBytecodeScanner.matchCalls(callerBytes, SampleTarget.class.getName(), "other"));
        assertEquals(List.of(), OsgiBytecodeScanner.matchCalls(callerBytes, "", "ping"));
    }

    @Test
    public void classResolverAndSearcherWorkOutsideOsgi() {
        assertEquals(List.of("a.Foo", "a.Bar"), OsgiClassResolver.parseCandidates(" a.Foo , ; a..Bad , a.Bar "));
        assertEquals(List.of("p.Outer.Inner", "p.Outer$Inner", "p$Outer$Inner"),
                OsgiClassResolver.nestedVariants("p.Outer.Inner"));
        assertNull(OsgiClassResolver.resolveLoaded(null));

        ResolvedClassInfo loaded = OsgiClassResolver.resolveLoaded(SampleTarget.class);
        assertNotNull(loaded);
        assertEquals(SampleTarget.class.getName(), loaded.name());

        ClassLoader cl = SampleTarget.class.getClassLoader();
        ResolvedClassInfo byName = OsgiClassResolver.resolveFromCandidates(
                List.of("com.example.Nope", SampleTarget.class.getName()), List.of(cl));
        assertNotNull(byName);
        assertEquals(SampleTarget.class.getName(), byName.name());
        assertNotNull(OsgiClassResolver.tryLoadClass(cl, SampleTarget.class.getName()));
        assertNull(OsgiClassResolver.tryLoadClass(cl, "com.example.Nope"));

        assertTrue(OsgiClassSearcher.search("a..b", 10, null, List.of(cl), null).hits().isEmpty());
        var found = OsgiClassSearcher.search(SampleTarget.class.getName(), 10, null, List.of(cl), null);
        assertEquals(1, found.hits().size());
        assertEquals(SampleTarget.class.getName(), found.hits().get(0).fqcn());
    }

    @Test
    public void implementationFinderMatchesDirectTransitiveAbstractAndConcreteHierarchies() {
        String api = "com.example.ServiceApi";
        Map<String, ClassHierarchy> map = new LinkedHashMap<>();
        map.put("com.example.AbstractBase", new ClassHierarchy("com.example.AbstractBase", "java.lang.Object", List.of(api), 0x0400));
        map.put("com.example.ConcreteSub", new ClassHierarchy("com.example.ConcreteSub", "com.example.AbstractBase", List.of(), 0x0001));
        map.put("com.example.DirectImpl", new ClassHierarchy("com.example.DirectImpl", "java.lang.Object", List.of(api), 0x0001));
        map.put("com.example.SkipAnn", new ClassHierarchy("com.example.SkipAnn", "java.lang.Object", List.of(api), 0x2000));

        List<ImplHit> concreteOnly = OsgiImplementationFinder.matchHierarchies(api, map, 9L, "b 1.0", "p.key", false, 10);
        assertEquals(List.of("com.example.DirectImpl", "com.example.ConcreteSub"),
                concreteOnly.stream().map(ImplHit::fqcn).toList());
        assertEquals("direct", concreteOnly.get(0).via());
        assertEquals("extends/implements com.example.AbstractBase", concreteOnly.get(1).via());

        List<ImplHit> withAbstractLimited = OsgiImplementationFinder.matchHierarchies(api, map, 9L, "b 1.0", "p.key", true, 2);
        assertEquals(2, withAbstractLimited.size());
        assertTrue(withAbstractLimited.get(0).isAbstract());
    }

    private static Bundle bundleWithState(int state) {
        Bundle b = mock(Bundle.class);
        when(b.getState()).thenReturn(state);
        return b;
    }
}
