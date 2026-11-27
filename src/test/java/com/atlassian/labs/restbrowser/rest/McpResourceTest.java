package com.atlassian.labs.restbrowser.rest;

import com.atlassian.labs.restbrowser.catalog.CatalogService;
import com.atlassian.labs.restbrowser.catalog.CatalogSnapshot;
import com.atlassian.labs.restbrowser.catalog.CatalogTestSupport;
import com.atlassian.labs.restbrowser.catalog.Model.ModuleEntry;
import com.atlassian.labs.restbrowser.catalog.Model.Operation;
import com.atlassian.labs.restbrowser.catalog.Model.State;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery;
import com.atlassian.labs.restbrowser.catalog.OperationDetails;
import com.atlassian.labs.restbrowser.catalog.OperationSource;
import com.atlassian.labs.restbrowser.catalog.OperationSourceTest;
import com.atlassian.labs.restbrowser.json.JsonParser;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.UrlMode;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.ws.rs.core.Response;
import org.junit.Before;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

public class McpResourceTest {

    private final CatalogService catalog = mock(CatalogService.class);
    private final UserManager userManager = mock(UserManager.class);
    private final ApplicationProperties props = mock(ApplicationProperties.class);
    private final PluginAccessor plugins = mock(PluginAccessor.class);
    private final OperationDetails details = mock(OperationDetails.class);
    private final OperationSource source = new OperationSource(mock(ModuleDiscovery.class), () -> null);
    private final HttpServletRequest request = mock(HttpServletRequest.class);
    private McpResource resource;

    @Before
    public void setUp() {
        ModuleEntry m = CatalogTestSupport.module("demo", "demo/1", State.ok, "1.0");
        CatalogSnapshot snap = CatalogTestSupport.snapshot(
                List.of(m),
                List.of(new Operation("demo:GET:ping", "demo", CatalogTestSupport.spec("GET", "ping"))),
                true, "4.3.3-SNAPSHOT");
        when(catalog.current(any())).thenReturn(snap);
        when(props.getDisplayName()).thenReturn("Jira");
        when(props.getVersion()).thenReturn("11.3.13");
        when(props.getBuildNumber()).thenReturn("1");
        when(props.getBaseUrl(UrlMode.RELATIVE)).thenReturn("/jira");
        resource = new McpResource(catalog, userManager, props, plugins, details, source);

        UserKey admin = new UserKey("admin");
        when(userManager.getRemoteUserKey(request)).thenReturn(admin);
        when(userManager.isLicensed(admin)).thenReturn(true);
        when(userManager.isSystemAdmin(admin)).thenReturn(true);
    }

    @Test
    public void enforcesAuthMethodAndCrossOriginProtection() {
        Response getResp = resource.getNotAllowed();
        assertEquals(405, getResp.getStatus());
        assertEquals("POST", getResp.getHeaderString("Allow"));

        when(userManager.getRemoteUserKey(request)).thenReturn(null);
        assertEquals(401, resource.rpc(bytes("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}"), request).getStatus());

        UserKey licensedUser = new UserKey("dev");
        when(userManager.getRemoteUserKey(request)).thenReturn(licensedUser);
        when(userManager.isLicensed(licensedUser)).thenReturn(true);
        when(userManager.isSystemAdmin(licensedUser)).thenReturn(false);

        // Cross-origin cookie POST without PAT or XSRF token is blocked
        when(request.getHeader("Origin")).thenReturn("https://evil.example");
        when(request.getScheme()).thenReturn("https");
        when(request.getServerName()).thenReturn("jira.example");
        when(request.getServerPort()).thenReturn(443);
        assertEquals(403, resource.rpc(bytes("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}"), request).getStatus());

        // Bearer PAT bypasses browser XSRF friction even with Origin header
        when(request.getHeader("Authorization")).thenReturn("Bearer pat-secret");
        assertEquals(200, resource.rpc(bytes("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}"), request).getStatus());
    }

    @Test
    @SuppressWarnings("unchecked")
    public void supportsLifecycleToolsListRoleFilteringAndToolCalls() {
        Response init = resource.rpc(bytes("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}"), request);
        assertEquals(200, init.getStatus());
        Map<String, Object> initMap = JsonParser.parseObject((String) init.getEntity());
        Map<String, Object> initRes = (Map<String, Object>) initMap.get("result");
        assertEquals(McpResource.PROTOCOL_VERSION, initRes.get("protocolVersion"));
        Map<String, Object> caps = (Map<String, Object>) initRes.get("capabilities");
        assertTrue(caps.containsKey("tools"));
        assertTrue(caps.containsKey("resources"));
        assertTrue(caps.containsKey("prompts"));

        Response notif = resource.rpc(bytes("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}"), request);
        assertEquals(202, notif.getStatus());

        // Sysadmin sees all 16 tools
        Response adminToolsResp = resource.rpc(bytes("{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}"), request);
        List<Map<String, Object>> adminTools = (List<Map<String, Object>>)
                ((Map<String, Object>) JsonParser.parseObject((String) adminToolsResp.getEntity()).get("result")).get("tools");
        assertEquals(16, adminTools.size());

        // Resources & templates for sysadmin
        Response resListResp = resource.rpc(bytes("{\"jsonrpc\":\"2.0\",\"id\":21,\"method\":\"resources/list\"}"), request);
        List<Map<String, Object>> resList = (List<Map<String, Object>>)
                ((Map<String, Object>) JsonParser.parseObject((String) resListResp.getEntity()).get("result")).get("resources");
        assertEquals(4, resList.size());

        Response tplListResp = resource.rpc(bytes("{\"jsonrpc\":\"2.0\",\"id\":22,\"method\":\"resources/templates/list\"}"), request);
        List<Map<String, Object>> tplList = (List<Map<String, Object>>)
                ((Map<String, Object>) JsonParser.parseObject((String) tplListResp.getEntity()).get("result")).get("resourceTemplates");
        assertEquals(4, tplList.size());

        String cls = OperationSourceTest.SampleResource.class.getName();
        for (String uri : List.of("rab://llms.txt", "rab://llms-full.txt", "rab://catalog/summary",
                "rab://openapi/self", "rab://catalog/openapi/demo",
                "rab://code/class/" + cls, "rab://code/source/" + cls)) {
            Response rr = resource.rpc(bytes("{\"jsonrpc\":\"2.0\",\"id\":23,\"method\":\"resources/read\",\"params\":{\"uri\":\"" + uri + "\"}}"), request);
            Map<String, Object> rRes = (Map<String, Object>) JsonParser.parseObject((String) rr.getEntity()).get("result");
            List<Map<String, Object>> contents = (List<Map<String, Object>>) rRes.get("contents");
            assertEquals(1, contents.size());
            assertFalse(String.valueOf(contents.get(0).get("text")).isBlank());
        }

        // Prompts for sysadmin
        Response promptsResp = resource.rpc(bytes("{\"jsonrpc\":\"2.0\",\"id\":24,\"method\":\"prompts/list\"}"), request);
        List<Map<String, Object>> prompts = (List<Map<String, Object>>)
                ((Map<String, Object>) JsonParser.parseObject((String) promptsResp.getEntity()).get("result")).get("prompts");
        assertEquals(3, prompts.size());

        Response debugPrompt = resource.rpc(bytes(
                "{\"jsonrpc\":\"2.0\",\"id\":25,\"method\":\"prompts/get\",\"params\":{\"name\":\"debug-stuck-endpoint\",\"arguments\":{\"target\":\"/rest/api/2/issue\"}}}"), request);
        Map<String, Object> pRes = (Map<String, Object>) JsonParser.parseObject((String) debugPrompt.getEntity()).get("result");
        List<Map<String, Object>> msgs = (List<Map<String, Object>>) pRes.get("messages");
        String pText = String.valueOf(((Map<String, Object>) msgs.get(0).get("content")).get("text"));
        assertTrue(pText.contains("/rest/api/2/issue"));

        // Unknown resource yields -32002
        Response unknownRes = resource.rpc(bytes("{\"jsonrpc\":\"2.0\",\"id\":26,\"method\":\"resources/read\",\"params\":{\"uri\":\"rab://no/such\"}}"), request);
        assertEquals(-32002L, ((Map<String, Object>) JsonParser.parseObject((String) unknownRes.getEntity()).get("error")).get("code"));

        // Call search_operations & inspect_class as sysadmin
        Response searchCall = resource.rpc(bytes(
                "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"search_operations\",\"arguments\":{\"q\":\"ping\"}}}"), request);
        Map<String, Object> searchRes = (Map<String, Object>) JsonParser.parseObject((String) searchCall.getEntity()).get("result");
        assertEquals(Boolean.FALSE, searchRes.get("isError"));
        String searchText = String.valueOf(((List<Map<String, Object>>) searchRes.get("content")).get(0).get("text"));
        assertTrue(searchText.contains("demo:GET:ping"));

        Response clsCall = resource.rpc(bytes(
                "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"inspect_class\",\"arguments\":{\"class\":\"" + cls + "\",\"outline\":true}}}"), request);
        Map<String, Object> clsRes = (Map<String, Object>) JsonParser.parseObject((String) clsCall.getEntity()).get("result");
        assertEquals(Boolean.FALSE, clsRes.get("isError"));
        assertTrue(String.valueOf(((List<Map<String, Object>>) clsRes.get("content")).get(0).get("text")).contains("\"outline\""));

        // Non-sysadmin sees only 4 catalog tools, 1 resource template, 1 prompt, and gets JSON-RPC -32003 on code/sysadmin resources & prompts
        UserKey dev = new UserKey("dev");
        when(userManager.getRemoteUserKey(request)).thenReturn(dev);
        when(userManager.isLicensed(dev)).thenReturn(true);
        when(userManager.isSystemAdmin(dev)).thenReturn(false);

        Response devToolsResp = resource.rpc(bytes("{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/list\"}"), request);
        List<Map<String, Object>> devTools = (List<Map<String, Object>>)
                ((Map<String, Object>) JsonParser.parseObject((String) devToolsResp.getEntity()).get("result")).get("tools");
        assertEquals(4, devTools.size());

        Response devTplResp = resource.rpc(bytes("{\"jsonrpc\":\"2.0\",\"id\":51,\"method\":\"resources/templates/list\"}"), request);
        List<Map<String, Object>> devTpls = (List<Map<String, Object>>)
                ((Map<String, Object>) JsonParser.parseObject((String) devTplResp.getEntity()).get("result")).get("resourceTemplates");
        assertEquals(1, devTpls.size());

        Response devPromptsResp = resource.rpc(bytes("{\"jsonrpc\":\"2.0\",\"id\":52,\"method\":\"prompts/list\"}"), request);
        List<Map<String, Object>> devPrompts = (List<Map<String, Object>>)
                ((Map<String, Object>) JsonParser.parseObject((String) devPromptsResp.getEntity()).get("result")).get("prompts");
        assertEquals(1, devPrompts.size());

        Response forbiddenCodeRes = resource.rpc(bytes(
                "{\"jsonrpc\":\"2.0\",\"id\":53,\"method\":\"resources/read\",\"params\":{\"uri\":\"rab://code/class/" + cls + "\"}}"), request);
        assertEquals(-32003L, ((Map<String, Object>) JsonParser.parseObject((String) forbiddenCodeRes.getEntity()).get("error")).get("code"));

        Response forbiddenPrompt = resource.rpc(bytes(
                "{\"jsonrpc\":\"2.0\",\"id\":54,\"method\":\"prompts/get\",\"params\":{\"name\":\"debug-stuck-endpoint\"}}"), request);
        assertEquals(-32003L, ((Map<String, Object>) JsonParser.parseObject((String) forbiddenPrompt.getEntity()).get("error")).get("code"));

        Response forbiddenTool = resource.rpc(bytes(
                "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"inspect_class\",\"arguments\":{\"class\":\"" + cls + "\"}}}"), request);
        Map<String, Object> errMap = (Map<String, Object>) JsonParser.parseObject((String) forbiddenTool.getEntity()).get("error");
        assertEquals(-32003L, errMap.get("code"));

        // Unknown method & parse error
        Response badMethod = resource.rpc(bytes("{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"no/such\"}"), request);
        assertEquals(-32601L, ((Map<String, Object>) JsonParser.parseObject((String) badMethod.getEntity()).get("error")).get("code"));

        Response parseErr = resource.rpc(bytes("{bad"), request);
        assertEquals(-32700L, ((Map<String, Object>) JsonParser.parseObject((String) parseErr.getEntity()).get("error")).get("code"));
    }

    private static InputStream bytes(String s) {
        return new ByteArrayInputStream(s.getBytes(StandardCharsets.UTF_8));
    }
}
