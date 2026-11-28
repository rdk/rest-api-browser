package com.atlassian.labs.restbrowser.inspect.osgi;

import com.atlassian.labs.restbrowser.inspect.osgi.OsgiBundleResourceReader.ResourceContent;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiBundleResourceReader.ResourceList;
import org.junit.Test;
import org.osgi.framework.Bundle;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.URI;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLStreamHandler;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.*;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

public class OsgiBundleResourceReaderTest {

    @Test
    public void sanitizesPathsAndRejectsTraversalOrControlChars() {
        assertEquals("atlassian-plugin.xml", OsgiBundleResourceReader.sanitizePath("/atlassian-plugin.xml"));
        assertEquals("META-INF/spring/beans.xml", OsgiBundleResourceReader.sanitizePath("META-INF/spring/beans.xml"));

        assertNull(OsgiBundleResourceReader.sanitizePath(null));
        assertNull(OsgiBundleResourceReader.sanitizePath("   "));
        assertNull(OsgiBundleResourceReader.sanitizePath("../secret.xml"));
        assertNull(OsgiBundleResourceReader.sanitizePath("a/../b.xml"));
        assertNull(OsgiBundleResourceReader.sanitizePath("a\\b.xml"));
        assertNull(OsgiBundleResourceReader.sanitizePath("file:/etc/passwd"));
        assertNull(OsgiBundleResourceReader.sanitizePath("bad\u0000name.xml"));
        assertNull(OsgiBundleResourceReader.sanitizePath("dir/"));
        assertNull(OsgiBundleResourceReader.sanitizePath("x".repeat(501)));
    }

    @Test
    public void classifiesResourceKindsCleanly() {
        assertEquals("descriptor", OsgiBundleResourceReader.classifyKind("atlassian-plugin.xml"));
        assertEquals("descriptor", OsgiBundleResourceReader.classifyKind("META-INF/MANIFEST.MF"));
        assertEquals("descriptor", OsgiBundleResourceReader.classifyKind("META-INF/spring/plugin-context.xml"));
        assertEquals("template", OsgiBundleResourceReader.classifyKind("templates/dialog.vm"));
        assertEquals("i18n", OsgiBundleResourceReader.classifyKind("i18n/messages.properties"));
        assertEquals("web", OsgiBundleResourceReader.classifyKind("assets/next/next.js"));
        assertEquals("config", OsgiBundleResourceReader.classifyKind("schema/config.json"));
        assertEquals("other", OsgiBundleResourceReader.classifyKind("NOTICE.txt"));
    }

    @Test
    public void listsFiltersAndReadsBundleResourcesSafely() throws Exception {
        Bundle b = mock(Bundle.class);
        when(b.getBundleId()).thenReturn(42L);

        URL dirUrl = inMemoryUrl("/templates/", "");
        URL classUrl = inMemoryUrl("/com/example/Foo.class", "bytecode");
        URL xmlUrl = inMemoryUrl("/atlassian-plugin.xml", "<atlassian-plugin key=\"demo\"/>");
        URL vmUrl = inMemoryUrl("/templates/view.vm", "<div>$body</div>");
        when(b.findEntries("/", "*", true))
                .thenAnswer(inv -> Collections.enumeration(List.of(dirUrl, classUrl, xmlUrl, vmUrl)));

        ResourceList listed = OsgiBundleResourceReader.listResources(b, null, 50);
        assertFalse(listed.truncated());
        assertEquals(2, listed.entries().size());
        assertEquals("atlassian-plugin.xml", listed.entries().get(0).path());
        assertEquals("templates/view.vm", listed.entries().get(1).path());

        ResourceList prefixed = OsgiBundleResourceReader.listResources(b, "/templates/", 10);
        assertEquals(1, prefixed.entries().size());
        assertEquals("template", prefixed.entries().get(0).kind());

        when(b.getEntry("atlassian-plugin.xml")).thenReturn(xmlUrl);
        ResourceContent ok = OsgiBundleResourceReader.readResource(b, "atlassian-plugin.xml", 1024);
        assertTrue(ok.ok());
        assertEquals("<atlassian-plugin key=\"demo\"/>", ok.content());

        assertEquals("binary-resource", OsgiBundleResourceReader.readResource(b, "com/example/Foo.class", 1024).errorCode());
        assertEquals("binary-resource", OsgiBundleResourceReader.readResource(b, "img/logo.png", 1024).errorCode());
        assertEquals("invalid-path", OsgiBundleResourceReader.readResource(b, "../etc/passwd", 1024).errorCode());
        assertEquals("resource-not-found", OsgiBundleResourceReader.readResource(b, "missing.txt", 1024).errorCode());

        // Stream truncation & NUL binary sniff
        ResourceContent truncated = OsgiBundleResourceReader.readStream("big.txt",
                new ByteArrayInputStream("0123456789".getBytes(StandardCharsets.UTF_8)), 5);
        assertTrue(truncated.ok());
        assertTrue(truncated.truncated());
        assertEquals("01234", truncated.content());

        ResourceContent nul = OsgiBundleResourceReader.readStream("bin.dat",
                new ByteArrayInputStream(new byte[]{'A', 0, 'B'}), 100);
        assertFalse(nul.ok());
        assertEquals("binary-resource", nul.errorCode());
    }

    private static URL inMemoryUrl(String path, String content) throws IOException {
        byte[] data = content.getBytes(StandardCharsets.UTF_8);
        return URL.of(URI.create("memory://bundle" + path), new URLStreamHandler() {
            @Override
            protected URLConnection openConnection(URL u) {
                return new URLConnection(u) {
                    @Override public void connect() {}
                    @Override public java.io.InputStream getInputStream() {
                        return new ByteArrayInputStream(data);
                    }
                };
            }
        });
    }
}
