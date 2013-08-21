package com.atlassian.labs.restbrowser.plugin;

import java.util.Map;

/**
 * Provides a {@code Map} of platform components, names to versions.
 */
public interface PlatformComponents {

    /**
     * Returns a {@code Map} of platform pieces ("plugins", "velocity",
     * "gadgets", etc.) to their detected versions.
     * @return a {@code Map} of platform pieces
     */
    Map<String, String> getPlatformComponents();
    
}
