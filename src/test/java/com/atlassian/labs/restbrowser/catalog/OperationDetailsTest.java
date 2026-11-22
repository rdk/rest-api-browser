package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.annotations.security.AdminOnly;
import com.atlassian.labs.restbrowser.catalog.JerseyModelSource.Handler;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery.RestModule;
import com.atlassian.plugin.ModuleDescriptor;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginInformation;
import com.atlassian.plugin.PluginState;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.QueryParam;
import org.junit.Test;

import java.io.IOException;
import java.lang.reflect.Method;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
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
