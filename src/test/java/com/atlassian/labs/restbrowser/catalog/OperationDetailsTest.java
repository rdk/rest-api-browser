package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.annotations.security.AdminOnly;
import com.atlassian.labs.restbrowser.catalog.JerseyModelSource.Handler;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery.RestModule;
import com.atlassian.labs.restbrowser.json.Json;
import com.atlassian.plugin.ModuleDescriptor;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginInformation;
import com.atlassian.plugin.PluginState;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.QueryParam;
import org.junit.Test;
import org.osgi.framework.Bundle;
import org.osgi.framework.BundleReference;
import org.osgi.framework.Version;
import org.osgi.framework.wiring.BundleCapability;
import org.osgi.framework.wiring.BundleRevision;
import org.osgi.framework.wiring.BundleWire;
import org.osgi.framework.wiring.BundleWiring;

import java.io.IOException;
import java.io.InputStream;
import java.lang.annotation.Annotation;
import java.lang.reflect.AnnotatedElement;
import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.Hashtable;
import java.util.List;
import java.util.Map;

import static java.util.Objects.requireNonNull;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

public class OperationDetailsTest {

    /** A resource as a plugin would write one. */
    @Path("/things")
    @AdminOnly
    public static class ThingResource implements Comparable<ThingResource> {
        @GET
        @Path("{id}")
        @Deprecated
        public Map<String, List<Thread.State>> get(@PathParam("id") String id, @QueryParam("n") int n) throws IOException {
            return Map.of();
        }

        @Override
        public int compareTo(ThingResource o) {
            return 0;
        }
    }

    private static Method get() throws NoSuchMethodException {
        return ThingResource.class.getMethod("get", String.class, int.class);
    }

    private static RestModule module(String id, Plugin plugin) {
        return new RestModule(id, "things/1", "/things", "1", true, "p", "P", "1.0", "Things", plugin, null);
    }

    /** An annotation with defaults, as OpenAPI's are. */
    @java.lang.annotation.Retention(java.lang.annotation.RetentionPolicy.RUNTIME)
    public @interface Doc {
        String summary() default "";
        String[] tags() default {};
        boolean hidden() default false;
        Thread.State state() default Thread.State.NEW;
        Class<?> type() default Void.class;
        Path[] paths() default {};
    }

    @Doc(summary = "Gets a \"thing\"", tags = {"a", "b"}, state = Thread.State.BLOCKED, paths = @Path("x"))
    private static final class Documented {
    }

    @Test
    public void annotationsShowOnlyWhatDiffersFromTheDefaults() {
        String doc = OperationDetails.annotation(Documented.class.getAnnotation(Doc.class));
        assertEquals("@" + Doc.class.getName() + "(paths=@jakarta.ws.rs.Path(\"x\"), state=java.lang.Thread$State.BLOCKED, "
                + "summary=\"Gets a \\\"thing\\\"\", tags={\"a\", \"b\"})", doc);
        assertEquals("@jakarta.ws.rs.Path(\"/things\")", OperationDetails.annotation(ThingResource.class.getAnnotation(Path.class)));
    }

    /** Literals that need escapes. */
    @java.lang.annotation.Retention(java.lang.annotation.RetentionPolicy.RUNTIME)
    public @interface Literal {
        String text() default "";
        char[] chars() default {};
    }

    @Literal(text = "a\tb\r\nc\\d\"e'f", chars = {'\'', '\\', '\n', '\r', '\t', '"'})
    private static final class Escaped {
    }

    @Test
    public void stringsAndCharsAreEscapedAsInSource() {
        assertEquals("@" + Literal.class.getName() + "(chars={'\\'', '\\\\', '\\n', '\\r', '\\t', '\"'}, "
                        + "text=\"a\\tb\\r\\nc\\\\d\\\"e'f\")",
                OperationDetails.annotation(Escaped.class.getAnnotation(Literal.class)));
    }

    /** Two members, so one can fail. */
    @java.lang.annotation.Retention(java.lang.annotation.RetentionPolicy.RUNTIME)
    public @interface Two {
        String a() default "";
        String b() default "";
    }

    @Test
    @SuppressWarnings("ClassExplicitlyAnnotation")
    public void aMemberThatCannotBeReadIsAQuestionMarkAndTheOthersStay() {
        Two broken = new Two() {
            @Override
            public String a() {
                throw new IllegalStateException("gone");
            }

            @Override
            public String b() {
                return "x";
            }

            @Override
            public Class<? extends java.lang.annotation.Annotation> annotationType() {
                return Two.class;
            }
        };
        assertEquals("@" + Two.class.getName() + "(a=?, b=\"x\")", OperationDetails.annotation(broken));
    }

    /** Type variables, one bounded by itself. */
    public static class Generic {
        public <T extends Comparable<T>, E extends Exception> T max(List<? extends T> items) throws E {
            return null;
        }
    }

    @Test
    public void aTypeVariableGivesItsBoundsOnce() throws Exception {
        Method max = Generic.class.getMethod("max", List.class);
        assertEquals(List.of(Comparable.class, List.class, Exception.class), OperationDetails.signatureTypes(max));
    }

    @Test
    public void javaxIsTheJdkOnlyWhenTheJdkLoadsIt() throws Exception {
        assertEquals("JDK", OperationDetails.origin(javax.sql.DataSource.class)); // the platform class loader
        assertEquals("JDK", OperationDetails.origin(javax.net.ssl.SSLContext.class)); // the boot class loader
        Class<?> inject = Class.forName("javax.inject.Inject"); // a jar on the class path, as in the product
        assertTrue(OperationDetails.origin(inject), OperationDetails.origin(inject).startsWith("the product ("));
    }

    /** A class loader that is a bundle's, as OSGi's are; FrameworkUtil finds the bundle through it. */
    private static final class BundleLoader extends ClassLoader implements BundleReference {
        private final Bundle bundle;

        BundleLoader(Bundle bundle) {
            super(OperationDetailsTest.class.getClassLoader());
            this.bundle = bundle;
        }

        @Override
        public Bundle getBundle() {
            return bundle;
        }

        Class<?> copy(Class<?> c) throws IOException {
            try (InputStream in = c.getClassLoader().getResourceAsStream(c.getName().replace('.', '/') + ".class")) {
                byte[] b = requireNonNull(in).readAllBytes();
                return defineClass(c.getName(), b, 0, b.length);
            }
        }
    }

    /** A class for the bundle. */
    public static final class Plain {
    }

    private static Bundle bundle(String name, String version, long id) {
        Bundle b = mock(Bundle.class);
        when(b.getSymbolicName()).thenReturn(name);
        when(b.getVersion()).thenReturn(new Version(version));
        when(b.getBundleId()).thenReturn(id);
        return b;
    }

    private static BundleCapability capability(String pkg, Version version) {
        BundleCapability c = mock(BundleCapability.class);
        Map<String, Object> attrs = new HashMap<>();
        attrs.put(BundleRevision.PACKAGE_NAMESPACE, pkg);
        if (version != null) {
            attrs.put("version", version);
        }
        when(c.getAttributes()).thenReturn(attrs);
        return c;
    }

    private static BundleWire wire(BundleCapability capability, Bundle provider) {
        BundleWire w = mock(BundleWire.class);
        when(w.getCapability()).thenReturn(capability);
        if (provider != null) {
            BundleWiring providerWiring = mock(BundleWiring.class);
            when(providerWiring.getBundle()).thenReturn(provider);
            when(w.getProviderWiring()).thenReturn(providerWiring);
        }
        return w;
    }

    @Test
    public void thePackagesOfABundleWithAndWithoutVersions() throws Exception {
        Bundle own = bundle("com.example.things", "1.0.0", 42);
        when(own.getHeaders()).thenReturn(new Hashtable<>(Map.of("Bundle-Name", "Things")));
        when(own.getState()).thenReturn(Bundle.ACTIVE);
        when(own.getLocation()).thenReturn("things.jar");
        BundleWiring wiring = mock(BundleWiring.class);
        when(wiring.isInUse()).thenReturn(true);
        when(own.adapt(BundleWiring.class)).thenReturn(wiring);
        Bundle provider = bundle("org.example", "2.0.0", 7);
        List<BundleWire> required = List.of(wire(capability("org.example.api", null), provider),
                wire(capability("org.example.util", new Version("2.1.0")), provider));
        when(wiring.getRequiredWires(BundleRevision.PACKAGE_NAMESPACE)).thenReturn(required);
        BundleCapability api = capability("com.example.things.api", new Version("1.0.0"));
        BundleCapability internal = capability("com.example.things.internal", null);
        List<BundleWire> provided = List.of(wire(api, null), wire(api, null)); // two bundles use the api
        when(wiring.getProvidedWires(BundleRevision.PACKAGE_NAMESPACE)).thenReturn(provided);
        when(wiring.getCapabilities(BundleRevision.PACKAGE_NAMESPACE)).thenReturn(List.of(internal, api));

        Class<?> c = new BundleLoader(own).copy(Plain.class);
        assertEquals("com.example.things 1.0.0", OperationDetails.origin(c));
        Json j = new Json();
        OperationDetails.bundle(j, c);
        String json = j.toString();
        assertTrue(json, json.contains("\"symbolicName\":\"com.example.things\",\"version\":\"1.0.0\",\"state\":\"ACTIVE\""));
        assertTrue(json, json.contains("\"imports\":[{\"package\":\"org.example.api\",\"version\":\"\",\"from\":\"org.example 2.0.0\",\"fromId\":\"7\"},"
                + "{\"package\":\"org.example.util\",\"version\":\"2.1.0\""));
        assertTrue(json, json.contains("\"exports\":[{\"package\":\"com.example.things.api\",\"version\":\"1.0.0\",\"users\":2},"
                + "{\"package\":\"com.example.things.internal\",\"version\":\"\",\"users\":0}]"));
        assertFalse(json, json.contains("null"));
    }

    private static Bundle activeBundle(BundleWiring wiring) {
        Bundle own = bundle("com.example.things", "1.0.0", 42);
        when(own.getHeaders()).thenReturn(new Hashtable<>(Map.of("Bundle-Name", "Things")));
        when(own.getState()).thenReturn(Bundle.ACTIVE);
        when(own.getLocation()).thenReturn("things.jar");
        when(own.adapt(BundleWiring.class)).thenReturn(wiring);
        return own;
    }

    @Test
    public void aWiringNoLongerInUseKeepsTheBundlesFacts() throws Exception {
        // a refresh replaced the wiring while the details were read: its lists are null now
        BundleWiring stale = mock(BundleWiring.class);
        when(stale.isInUse()).thenReturn(false);
        when(stale.getRequiredWires(BundleRevision.PACKAGE_NAMESPACE)).thenReturn(null);
        Json j = new Json();
        OperationDetails.bundle(j, new BundleLoader(activeBundle(stale)).copy(Plain.class));
        assertEquals("{\"id\":42,\"symbolicName\":\"com.example.things\",\"version\":\"1.0.0\",\"state\":\"ACTIVE\","
                + "\"location\":\"things.jar\",\"lastModified\":0,\"headers\":{\"Bundle-Name\":\"Things\"},\"wiring\":false}", j.toString());
    }

    @Test
    public void listsThatTurnNullAreEmpty() throws Exception {
        // still in use when asked, gone by the time each list is read
        BundleWiring racing = mock(BundleWiring.class);
        when(racing.isInUse()).thenReturn(true);
        when(racing.getRequiredWires(BundleRevision.PACKAGE_NAMESPACE)).thenReturn(null);
        when(racing.getProvidedWires(BundleRevision.PACKAGE_NAMESPACE)).thenReturn(null);
        when(racing.getCapabilities(BundleRevision.PACKAGE_NAMESPACE)).thenReturn(null);
        Json j = new Json();
        OperationDetails.bundle(j, new BundleLoader(activeBundle(racing)).copy(Plain.class));
        String json = j.toString();
        assertTrue(json, json.startsWith("{\"id\":42,\"symbolicName\":\"com.example.things\""));
        assertTrue(json, json.endsWith("\"importCount\":0,\"imports\":[],\"exportCount\":0,\"exports\":[]}"));
    }

    /** A class value. */
    @java.lang.annotation.Retention(java.lang.annotation.RetentionPolicy.RUNTIME)
    public @interface Typed {
        Class<?>[] value();
    }

    @Typed({String[].class, int[][].class, Map.Entry.class})
    private static final class WithArrays {
    }

    @Test
    public void classValuesAreWrittenAsInSource() {
        assertEquals("@" + Typed.class.getName() + "({java.lang.String[].class, int[][].class, java.util.Map$Entry.class})",
                OperationDetails.annotation(WithArrays.class.getAnnotation(Typed.class)));
    }

    @Test
    @SuppressWarnings("ClassExplicitlyAnnotation")
    public void oneUnreadableAnnotationDoesNotLoseTheOthers() {
        Annotation broken = new Two() {
            @Override
            public String a() {
                return "";
            }

            @Override
            public String b() {
                return "";
            }

            @Override
            public Class<? extends Annotation> annotationType() {
                throw new NoClassDefFoundError("com/example/Gone");
            }
        };
        Annotation path = ThingResource.class.getAnnotation(Path.class);
        AnnotatedElement element = new AnnotatedElement() {
            @Override
            public <T extends Annotation> T getAnnotation(Class<T> type) {
                return null;
            }

            @Override
            public Annotation[] getAnnotations() {
                return getDeclaredAnnotations();
            }

            @Override
            public Annotation[] getDeclaredAnnotations() {
                return new Annotation[]{broken, path};
            }
        };
        assertEquals(List.of("(unreadable: java.lang.NoClassDefFoundError: com/example/Gone)",
                "@jakarta.ws.rs.Path(\"/things\")"), OperationDetails.annotations(element));
    }

    @Test
    public void textIsCutButNeverInsideASurrogatePair() {
        String smile = "😀";
        assertEquals("a".repeat(499) + "…", OperationDetails.clip("a".repeat(499) + smile + "b"));
        assertEquals("a".repeat(498) + smile + "…", OperationDetails.clip("a".repeat(498) + smile + "bc"));
        assertEquals("a".repeat(500), OperationDetails.clip("a".repeat(500)));
        assertNull(OperationDetails.clip(null));
    }

    @Test
    public void theModuleOfAKeyIsTheLongestIdItStartsWith() {
        RestModule a = module("p:rest", null), b = module("p:rest-v2", null), c = module("p:rest:x", null);
        List<RestModule> all = List.of(a, b, c);
        assertSame(a, OperationDetails.moduleOf(all, "p:rest:GET:things/{}"));
        assertSame(b, OperationDetails.moduleOf(all, "p:rest-v2:GET:things"));
        assertSame(c, OperationDetails.moduleOf(all, "p:rest:x:POST:things"));
        assertNull(OperationDetails.moduleOf(all, "q:rest:GET:things"));
    }

    @Test
    public void theMethodWithItsAnnotationsParametersAndTypes() throws Exception {
        Json j = new Json();
        OperationDetails.method(j, get());
        String json = j.toString();
        assertTrue(json, json.contains("\"name\":\"get\""));
        assertTrue(json, json.contains("\"returns\":\"java.util.Map\\u003cjava.lang.String, java.util.List\\u003cjava.lang.Thread$State>>\""));
        assertTrue(json, json.contains("\"throws\":[\"java.io.IOException\"]"));
        assertTrue(json, json.contains("\"@jakarta.ws.rs.GET\""));
        assertTrue(json, json.contains("@jakarta.ws.rs.PathParam(\\\"id\\\")"));
        assertTrue(json, json.contains("\"type\":\"int\""));
        assertTrue(json, json.contains("\"deprecated\":true"));
        assertEquals(List.of(Map.class, String.class, List.class, Thread.State.class, IOException.class),
                OperationDetails.signatureTypes(get()));
    }

    @Test
    public void theClassWithItsKindInterfacesAndAnnotations() {
        Json j = new Json();
        OperationDetails.type(j, ThingResource.class);
        String json = j.toString();
        assertTrue(json, json.contains("\"kind\":\"class\""));
        assertTrue(json, json.contains("\"modifiers\":\"public static\""));
        assertTrue(json, json.contains("java.lang.Comparable\\u003c" + ThingResource.class.getName() + ">"));
        assertTrue(json, json.contains("\"@com.atlassian.annotations.security.AdminOnly\""));
        assertTrue(json, json.contains("\"package\":\"com.atlassian.labs.restbrowser.catalog\""));
    }

    @Test
    public void outsideOsgiTheBundleSaysWhereTheClassComesFrom() {
        Json j = new Json();
        OperationDetails.bundle(j, String.class);
        assertEquals("{\"none\":\"JDK\"}", j.toString());
        assertEquals("JDK", OperationDetails.origin(Map.class));
        assertTrue(OperationDetails.origin(ThingResource.class).startsWith("the product ("));
    }

    @Test
    public void wholeDetailsWithThePluginAndTheModule() throws Exception {
        Plugin plugin = mock(Plugin.class);
        PluginInformation info = mock(PluginInformation.class); // its constructor needs classes only the product has
        when(info.getVersion()).thenReturn("2.1");
        when(info.getVendorName()).thenReturn("Example");
        when(plugin.getKey()).thenReturn("com.example.things");
        when(plugin.getName()).thenReturn("Things");
        when(plugin.getPluginInformation()).thenReturn(info);
        when(plugin.getPluginState()).thenReturn(PluginState.ENABLED);
        when(plugin.getPluginsVersion()).thenReturn(2);
        ModuleDescriptor<?> md = mock(ModuleDescriptor.class);
        when(md.getKey()).thenReturn("rest");
        when(md.isEnabled()).thenReturn(true);
        when(plugin.getModuleDescriptors()).thenReturn(List.of(md));
        ProductAdapter product = new ProductAdapter("jira", () -> null);
        OperationDetails details = new OperationDetails(mock(ModuleDiscovery.class), () -> null, product);
        Method m = get();
        String json = details.json("p:rest:GET:things/{}", module("p:rest", plugin),
                new Handler(m, m, ThingResource.class, List.of()));
        assertTrue(json, json.startsWith("{\"format\":1,\"key\":\"p:rest:GET:things/{}\",\"method\":{"));
        assertTrue(json, json.contains("\"locators\":[]"));
        assertTrue(json, json.contains("\"resourceClass\":{\"name\":\"" + ThingResource.class.getName() + "\""));
        assertTrue(json, json.contains("\"plugin\":{\"key\":\"com.example.things\",\"name\":\"Things\",\"version\":\"2.1\",\"vendor\":\"Example\""));
        assertTrue(json, json.contains("\"moduleCount\":1"));
        assertTrue(json, json.contains("\"module\":{\"key\":\"p:rest\",\"path\":\"things/1\""));
        assertTrue(json, json.contains("\"rest\":\"REST v2 (Jersey 2)\""));
    }

    @Test
    public void aSectionThatFailsSaysWhyAndTheOthersStay() throws Exception {
        Plugin plugin = mock(Plugin.class);
        when(plugin.getPluginInformation()).thenThrow(new IllegalStateException("gone"));
        OperationDetails details = new OperationDetails(mock(ModuleDiscovery.class), () -> null, new ProductAdapter("jira", () -> null));
        Method m = get();
        String json = details.json("p:rest:GET:x", module("p:rest", plugin), new Handler(m, m, null, List.of()));
        assertTrue(json, json.contains("\"plugin\":{\"error\":\"java.lang.IllegalStateException: gone\"}"));
        assertTrue(json, json.contains("\"method\":{\"class\":"));
    }

    @Test
    public void unknownKeysAndModules() {
        ModuleDiscovery discovery = mock(ModuleDiscovery.class);
        when(discovery.discover()).thenReturn(List.of(module("p:rest", null)));
        OperationDetails details = new OperationDetails(discovery, () -> null, new ProductAdapter("jira", () -> null));
        assertEquals(400, details.describe(" ").status());
        assertEquals(404, details.describe("q:rest:GET:x").status());
        assertEquals("{\"error\":\"not-described\"}", details.describe("p:rest:GET:x").json());
        assertEquals("ACTIVE", OperationDetails.state(org.osgi.framework.Bundle.ACTIVE));
    }
}
