package com.atlassian.labs.restbrowser.rest;

import com.atlassian.annotations.security.XsrfProtectionExcluded;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.Test;

import java.lang.reflect.Method;
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
        assertEquals("JSESSIONID=… (6 characters, hidden); atl.xsrf.token=… (3 characters, hidden); "
                        + "… (a value without a name, 6 characters, hidden)",
                EchoResource.safe("Cookie", "JSESSIONID=abc123; atl.xsrf.token=xyz; s3cr3t"));
        assertEquals("$Version=… (3 characters, hidden); sid=… (3 characters, hidden)",
                EchoResource.safe("Cookie2", "$Version=\"1\"; sid=abc"));
        assertEquals("sid=… (3 characters, hidden); Path=… (1 characters, hidden); "
                        + "… (a value without a name, 8 characters, hidden)",
                EchoResource.safe("Set-Cookie", "sid=abc; Path=/; HttpOnly"));
    }

    @Test
    public void credentialsAndSecretsAreHidden() {
        assertEquals("Basic … (hidden)", EchoResource.safe("Authorization", "Basic dXNlcjpwYXNz"));
        assertEquals("Bearer … (hidden)", EchoResource.safe("Proxy-Authorization", "Bearer abc"));
        assertEquals("AWS4-HMAC-SHA256 … (hidden)",
                EchoResource.safe("Authorization", "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260101/x"));
        assertEquals("Negotiate … (hidden)", EchoResource.safe("Authorization", "Negotiate\tYIIabc"));
        assertEquals("… (hidden)", EchoResource.safe("authorization", "opaque"));
        // a first word that is no scheme is part of the secret
        assertEquals("… (hidden)", EchoResource.safe("Authorization", "4f9a:secret rest"));
        assertEquals("… (hidden)", EchoResource.safe("Authorization", "a".repeat(33) + " rest"));
        assertEquals("… (hidden)", EchoResource.safe("Authorization", " Basic dXNl"));
        assertEquals("… (hidden)", EchoResource.safe("X-Api-Key", "k"));
        assertEquals("… (hidden)", EchoResource.safe("X-Session-Id", "s"));
        assertEquals("no-check", EchoResource.safe("X-Atlassian-Token", "no-check"));
        assertEquals("Mozilla/5.0", EchoResource.safe("User-Agent", "Mozilla/5.0"));
    }

    @Test
    public void secretNamesByTheirWordsWhateverTheSeparators() {
        for (String name : List.of("X-Client-Secret", "X-Password", "X-Passwd", "X-PWD", "X-Session-Id", "SESSION",
                "X-SessionId", "X-Api-Key", "X-API_KEY", "x_api_key", "X-Api-Keys", "X-ApiKey", "apikey",
                "X-Auth-Token", "X-Csrf-Token", "X-Amz-Security-Token", "X-Credentials", "X-JWT-Assertion",
                "Cf-Access-Jwt-Assertion", "X-Jwt", "X-Saml-Assertion", "X-Signature", "X-Hub-Signature-256",
                "X-Auth", "X-Authn", "X-Authz", "X-Bearer", "X-Forwarded-Authorization", "X-Forwarded-Client-Cert",
                "X-SSL-Client-Cert", "SSL_CLIENT_CERT", "X-Client-Certificate", "X-Amzn-Oidc-Data",
                "X-Amzn-Oidc-Accesstoken", "X-SSO-User", "X-Saml-Response", "X-Ms-Client-Principal",
                "X-MS-CLIENT-PRINCIPAL-NAME", "X-JSESSIONID", "X-OAuth-Scopes", "X-CSRF", "X-XSRF", "X-Xsrf-Header",
                "X-Forwarded-Cookie", "X-Cookie", "Ocp-Apim-Subscription-Key", "X-Functions-Key", "X-Private-Key",
                "X-Signing-Key", "X-Passphrase", "X-HMAC",
                // run together (HTTP/2 lowercases the names: both suffix and prefix compounds)
                "X-AccessToken", "x-accesstoken", "X-AuthToken", "X-ApiToken", "XApiKey", "X-ClientSecret",
                "X-UserPassword", "x-tokenvalue", "x-secretkey", "x-authheader", "x-webauth-user",
                "x-amzn-mtls-clientcert", "x-samlresponse", "x-oidcdata", "x-jwtpayload",
                "X-MyCookies", "x-usercookies")) {
            assertTrue(name, EchoResource.secret(name));
            assertEquals(name, "… (hidden)", EchoResource.safe(name, "v"));
        }
        assertTrue(EchoResource.safe("Set-Cookie2", "sid=secret").contains("sid=…"));
    }

    @Test
    public void nullHeaderEnumerationIsHandledSafely() {
        HttpServletRequest req = mock(HttpServletRequest.class);
        when(req.getMethod()).thenReturn("GET");
        when(req.getHeaderNames()).thenReturn(null);
        assertEquals("{\"method\":\"GET\",\"headers\":[]}", EchoResource.json(req));
    }

    @Test
    public void ordinaryNamesAndTheXsrfHeaderStayVisible() {
        // whole words only: "sso" in Processor, "auth" in Author and "cert" in Concert are not secrets
        for (String name : List.of("X-Atlassian-Token", "x_atlassian_token", "X-Processor", "X-Author-Id",
                "X-Concert-Id", "X-Cookies-Enabled", "X-Api-Version", "X-Key-Id", "Accept", "Accept-Language",
                "Content-Type", "User-Agent", "X-Forwarded-For", "X-Forwarded-Proto", "Origin", "Referer",
                "Sec-Fetch-Mode", "X-Requested-With", "Cache-Control", "Host")) {
            assertFalse(name, EchoResource.secret(name));
        }
        assertEquals("XMLHttpRequest", EchoResource.safe("X-Requested-With", "XMLHttpRequest"));
        assertEquals("p-1", EchoResource.safe("X-Processor", "p-1"));
    }

    @Test
    public void aLongValueIsCutButNeverInsideASurrogatePair() {
        String smile = "😀";
        assertEquals("a".repeat(999) + "…", EchoResource.safe("X-Long", "a".repeat(999) + smile + "b"));
        assertEquals("a".repeat(998) + smile + "…", EchoResource.safe("X-Long", "a".repeat(998) + smile + "bc"));
        assertEquals("a".repeat(1000), EchoResource.safe("X-Long", "a".repeat(1000)));
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
    public void onlyForLicensedUsers() {
        UserManager users = mock(UserManager.class);
        HttpServletRequest request = mock(HttpServletRequest.class);
        when(request.getMethod()).thenReturn("GET");
        when(request.getHeaderNames()).thenReturn(Collections.emptyEnumeration());
        EchoResource resource = new EchoResource(users);
        assertEquals(401, resource.get(request).getStatus());
        assertEquals(401, resource.post(request).getStatus());
        assertEquals(401, resource.put(request).getStatus());
        assertEquals(401, resource.patch(request).getStatus());
        assertEquals(401, resource.delete(request).getStatus());
        UserKey u = new UserKey("u");
        when(users.getRemoteUserKey(request)).thenReturn(u);
        when(users.isLicensed(u)).thenReturn(false);
        assertEquals(403, resource.get(request).getStatus());
        assertEquals(403, resource.post(request).getStatus());
        when(users.isLicensed(u)).thenReturn(true);
        assertEquals(200, resource.get(request).getStatus());
        assertTrue(((String) resource.get(request).getEntity()).startsWith("{\"method\":\"GET\""));
        assertEquals("no-store", resource.get(request).getHeaderString("Cache-Control"));
    }

    @Test
    public void theMutatingMethodsSkipTheXsrfCheck() throws Exception {
        // a copy of a request the user sent without X-Atlassian-Token must still be echoed
        for (String name : List.of("post", "put", "patch", "delete")) {
            Method m = EchoResource.class.getMethod(name, HttpServletRequest.class);
            assertTrue(name, m.isAnnotationPresent(XsrfProtectionExcluded.class));
        }
        assertFalse(EchoResource.class.getMethod("get", HttpServletRequest.class)
                .isAnnotationPresent(XsrfProtectionExcluded.class));
    }
}
