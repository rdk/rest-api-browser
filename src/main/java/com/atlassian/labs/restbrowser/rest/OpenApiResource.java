package com.atlassian.labs.restbrowser.rest;

import com.atlassian.annotations.security.LicensedOnly;
import com.atlassian.labs.restbrowser.catalog.OpenApiExporter;
import com.atlassian.labs.restbrowser.spring.LocalBeans;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.UrlMode;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import jakarta.inject.Inject;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.Context;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

/**
 * Serves the OpenAPI 3.1.0 specification of REST API Browser's own agent/UI REST endpoints at {@code /openapi}
 * (and via Atlassian REST v2's {@code .json} URI suffix conneg, {@code /openapi.json}).
 */
@Path("/openapi")
@LicensedOnly
public class OpenApiResource {

    private final ApplicationProperties applicationProperties;
    private final PluginAccessor pluginAccessor;
    private final UserManager userManager;

    @Inject
    public OpenApiResource(ApplicationProperties applicationProperties,
                           PluginAccessor pluginAccessor,
                           UserManager userManager) {
        this.applicationProperties = applicationProperties;
        this.pluginAccessor = pluginAccessor;
        this.userManager = userManager;
    }

    @GET
    @Produces(MediaType.APPLICATION_JSON)
    public Response spec(@Context HttpServletRequest request) {
        Response denied = RestAuth.requireLicensed(userManager, request);
        if (denied != null) {
            return denied;
        }
        UserKey user = RestAuth.remoteUser(userManager, request);
        boolean sysadmin = RestAuth.isSystemAdmin(userManager, user);
        String base = applicationProperties.getBaseUrl(UrlMode.CANONICAL);
        if (base == null || base.isBlank()) {
            base = applicationProperties.getBaseUrl(UrlMode.RELATIVE);
        }
        String version = LocalBeans.pluginVersion(pluginAccessor);
        String json = OpenApiExporter.selfSpecJson(base, version, sysadmin);
        return RestAuth.cacheableResponse(request, 200, RestAuth.JSON_MEDIA_TYPE, json);
    }
}
