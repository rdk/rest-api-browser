package com.atlassian.labs.restbrowser;

import org.junit.Test;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static java.util.Objects.requireNonNull;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Verifies every Classic UI resource referenced by {@code atlassian-plugin.xml} and {@code app.css}
 * is included in packaged build output (guards against overly broad Maven resource excludes).
 */
public class PluginResourcesTest {

    private static final Pattern CSS_URL = Pattern.compile("url\\([\"']?(rab/[^)\"']+)[\"']?\\)");

    @Test
    public void atlassianPluginDownloadResourcesExistOnClasspath() throws Exception {
        DocumentBuilderFactory dbf = DocumentBuilderFactory.newInstance();
        dbf.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        dbf.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        Document doc;
        try (InputStream in = getClass().getResourceAsStream("/atlassian-plugin.xml")) {
            assertNotNull("atlassian-plugin.xml missing from classpath", in);
            doc = dbf.newDocumentBuilder().parse(in);
        }

        NodeList resources = doc.getElementsByTagName("resource");
        int checked = 0;
        for (int i = 0; i < resources.getLength(); i++) {
            Element el = (Element) resources.item(i);
            if (!"download".equals(el.getAttribute("type"))) {
                continue;
            }
            String location = el.getAttribute("location");
            if (location.isEmpty() || location.endsWith("/") || location.startsWith("assets/next/")) {
                continue;
            }
            assertNotNull("Packaged resource missing from classpath: " + location,
                    getClass().getResource("/" + location));
            checked++;
        }
        assertTrue("Expected Classic UI download resources in atlassian-plugin.xml", checked > 15);
    }

    @Test
    public void classicAppCssImageUrlsExistOnClasspath() throws Exception {
        String css;
        try (InputStream in = getClass().getResourceAsStream("/assets/rab/app.css")) {
            css = new String(requireNonNull(in, "assets/rab/app.css missing").readAllBytes(), StandardCharsets.UTF_8);
        }
        Matcher m = CSS_URL.matcher(css);
        Set<String> checked = new HashSet<>();
        while (m.find()) {
            String rel = m.group(1);
            checked.add(rel);
            assertNotNull("CSS asset missing from classpath: assets/" + rel,
                    getClass().getResource("/assets/" + rel));
        }
        assertTrue(checked.contains("rab/images/getting-started.png"));
        assertTrue(checked.contains("rab/images/code.png"));
        assertFalse(checked.isEmpty());
    }
}
