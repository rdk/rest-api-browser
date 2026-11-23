package com.atlassian.labs.restbrowser.rest;

import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

public class EchoResourceTest {

    @Test
    public void cookiesShowTheirNamesAndLengthsOnly() {
        assertEquals("JSESSIONID=… (6 characters, hidden); atl.xsrf.token=… (3 characters, hidden); flag",
                EchoResource.safe("Cookie", "JSESSIONID=abc123; atl.xsrf.token=xyz; flag"));
    }

    @Test
    public void credentialsAndSecretsAreHidden() {
        assertEquals("Basic … (hidden)", EchoResource.safe("Authorization", "Basic dXNlcjpwYXNz"));
        assertEquals("… (hidden)", EchoResource.safe("authorization", "opaque"));
        assertEquals("… (hidden)", EchoResource.safe("X-Api-Key", "k"));
        assertEquals("… (hidden)", EchoResource.safe("X-Session-Id", "s"));
        assertEquals("no-check", EchoResource.safe("X-Atlassian-Token", "no-check"));
        assertEquals("Mozilla/5.0", EchoResource.safe("User-Agent", "Mozilla/5.0"));
    }

    @Test
    public void theRequestsHeadersInOrder() {
        HttpServletRequest request = mock(HttpServletRequest.class);
        when(request.getMethod()).thenReturn("POST");
        when(request.getHeaderNames()).thenReturn(Collections.enumeration(List.of("User-Agent", "Cookie", "Accept")));
        when(request.getHeaders("User-Agent")).thenReturn(Collections.enumeration(List.of("UA \"1\"")));
        when(request.getHeaders("Cookie")).thenReturn(Collections.enumeration(List.of("JSESSIONID=secret")));
        when(request.getHeaders("Accept")).thenReturn(Collections.enumeration(List.of("a", "b")));
        String json = EchoResource.json(request);
        assertEquals("{\"method\":\"POST\",\"headers\":[[\"User-Agent\",\"UA \\\"1\\\"\"],"
                + "[\"Cookie\",\"JSESSIONID=… (6 characters, hidden)\"],[\"Accept\",\"a\"],[\"Accept\",\"b\"]]}", json);
        assertFalse(json.contains("secret"));
    }

    @Test
    public void onlyForUsersWhoAreLoggedIn() {
        UserManager users = mock(UserManager.class);
        HttpServletRequest request = mock(HttpServletRequest.class);
        when(request.getMethod()).thenReturn("GET");
        when(request.getHeaderNames()).thenReturn(Collections.emptyEnumeration());
        EchoResource resource = new EchoResource(users);
        assertEquals(401, resource.get(request).getStatus());
        when(users.getRemoteUserKey(request)).thenReturn(new UserKey("u"));
        assertEquals(200, resource.get(request).getStatus());
        assertTrue(((String) resource.get(request).getEntity()).startsWith("{\"method\":\"GET\""));
        assertEquals("no-store", resource.get(request).getHeaderString("Cache-Control"));
    }
}
