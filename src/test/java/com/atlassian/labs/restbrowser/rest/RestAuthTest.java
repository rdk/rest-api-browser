package com.atlassian.labs.restbrowser.rest;

import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.ws.rs.core.Response;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

public class RestAuthTest {

    @Test
    public void failsClosedOnNullsRuntimeExceptionsAndLinkageErrors() {
        UserKey key = new UserKey("u");
        assertFalse(RestAuth.isLicensedUser(null, key));
        assertFalse(RestAuth.isLicensedUser(mock(UserManager.class), null));
        assertFalse(RestAuth.isSystemAdmin(null, key));
        assertFalse(RestAuth.isAdmin(null, key));

        UserManager failing = mock(UserManager.class);
        when(failing.isSystemAdmin(key)).thenThrow(new IllegalStateException("boom"));
        when(failing.isAdmin(key)).thenThrow(new LinkageError("missing"));
        assertFalse(RestAuth.isLicensedUser(failing, key));
        assertFalse(RestAuth.isSystemAdmin(failing, key));
        assertFalse(RestAuth.isAdmin(failing, key));
    }

    @Test
    public void enforcesLicensedAndSysadminAndSetsNoStore() {
        UserManager users = mock(UserManager.class);
        HttpServletRequest req = mock(HttpServletRequest.class);

        Response anon = RestAuth.requireLicensed(users, req);
        assertEquals(401, anon.getStatus());
        assertEquals("no-store", anon.getHeaderString("Cache-Control"));
        assertTrue(String.valueOf(anon.getEntity()).contains("login-required"));

        UserKey portal = new UserKey("portal");
        when(users.getRemoteUserKey(req)).thenReturn(portal);
        when(users.isLicensed(portal)).thenReturn(false);
        Response forbidden = RestAuth.requireLicensed(users, req);
        assertEquals(403, forbidden.getStatus());
        assertTrue(String.valueOf(forbidden.getEntity()).contains("licensed-user-required"));

        Response nonSys = RestAuth.requireSysadmin(users, req);
        assertEquals(403, nonSys.getStatus());
        assertTrue(String.valueOf(nonSys.getEntity()).contains("system-admin-only"));

        when(users.isLicensed(portal)).thenReturn(true);
        assertNull(RestAuth.requireLicensed(users, req));

        when(users.isSystemAdmin(portal)).thenReturn(true);
        assertNull(RestAuth.requireSysadmin(users, req));
    }

    @Test
    public void xsrfHeaderRequiresExactNoCheckValue() {
        HttpServletRequest req = mock(HttpServletRequest.class);
        assertFalse(RestAuth.xsrfHeader(req));
        when(req.getHeader("X-Atlassian-Token")).thenReturn("No-Check");
        assertFalse(RestAuth.xsrfHeader(req));
        when(req.getHeader("X-Atlassian-Token")).thenReturn("no-check");
        assertTrue(RestAuth.xsrfHeader(req));
    }
}
