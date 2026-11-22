package com.atlassian.labs.restbrowser.servlet;

import jakarta.servlet.http.HttpServletRequest;
import org.junit.Test;

import java.net.URI;

import static org.junit.Assert.assertEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

public class RequiresLoginServletTest {

    @Test
    public void bracesAndSpacesArePercentEncoded() {
        assertEquals("a%7Bb%7D%20c", RequiresLoginServlet.encodeIllegal("a{b} c"));
    }

    @Test
    public void nonAsciiIsEncodedAsUtf8() {
        assertEquals("%C3%A9", RequiresLoginServlet.encodeIllegal("\u00e9"));
        assertEquals("%E2%82%AC", RequiresLoginServlet.encodeIllegal("\u20ac"));
        assertEquals("%F0%9F%98%80", RequiresLoginServlet.encodeIllegal("\uD83D\uDE00"));
    }

    @Test
    public void aValidUrlIsUnchanged() {
        String url = "http://localhost:2990/jira/plugins/servlet/restbrowser?a=b&c=d%20e";
        assertEquals(url, RequiresLoginServlet.encodeIllegal(url));
    }

    @Test
    public void aPercentBeforeANonAsciiDigitIsStray() {
        // U+0660 ARABIC-INDIC DIGIT ZERO is a digit for Character.digit, not a hex digit of an escape
        assertEquals("http://h/x?a=%25%D9%A0%D9%A0", RequiresLoginServlet.encodeIllegal("http://h/x?a=%\u0660\u0660"));
    }

    @Test
    public void bracketsAStrayPercentAndHashAreEncodedButNotInTheAuthority() {
        assertEquals("http://[::1]:2990/jira?q.a%5B0%5D=1&p=100%25&x=%23y",
                RequiresLoginServlet.encodeIllegal("http://[::1]:2990/jira?q.a[0]=1&p=100%&x=#y"));
    }

    @Test
    public void getUriAcceptsABraceInTheQuery() {
        HttpServletRequest request = mock(HttpServletRequest.class);
        when(request.getRequestURL()).thenReturn(new StringBuffer("http://h/jira/plugins/servlet/restbrowser"));
        when(request.getQueryString()).thenReturn("op={}");
        URI uri = RequiresLoginServlet.getUri(request);
        assertEquals("http://h/jira/plugins/servlet/restbrowser?op=%7B%7D", uri.toASCIIString());
    }
}
