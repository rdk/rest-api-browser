package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.Model.ModuleSpec;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery.RestModule;

import java.util.Optional;

/**
 * Describes the operations of one REST module. Implementations return plain data only (no classes, methods or
 * plugin objects), see {@link Model}.
 */
public interface SpecSource {

    /** A short id, recorded per module: "jersey", later "classscan", "openapi", "wadl". */
    String id();

    /**
     * @return empty if this source does not handle the module
     * @throws SpecException with a short, safe reason code if it handles the module but failed
     */
    Optional<ModuleSpec> describe(RestModule module) throws SpecException;

    /** A failure to describe a module. The reason is a short code shown to everyone; the message is for admins. */
    class SpecException extends Exception {
        private final String reason;

        public SpecException(String reason, String message, Throwable cause) {
            super(message, cause);
            this.reason = reason;
        }

        public String reason() {
            return reason;
        }
    }
}
