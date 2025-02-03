package com.atlassian.labs.restbrowser.rest.services;

import com.atlassian.annotations.security.AnonymousSiteAccess;
import com.atlassian.templaterenderer.TemplateRenderer;

import jakarta.inject.Inject;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.io.IOException;
import java.io.StringWriter;

/**
 * Provides the ewadl resource.
 */
@Path("ewadl")
public class EwadlResource {

    // This WADL data describes Jira 5, so it doesn't seem very useful, especially in other products
    private static final String EWADL_TEMPLATE = "/templates/ewadl.vm";

    private final TemplateRenderer renderer;

    @Inject
    public EwadlResource(TemplateRenderer renderer) {
        this.renderer = renderer;
    }

    @AnonymousSiteAccess
    @GET
    @Produces(MediaType.APPLICATION_XML)
    public Response getWadl() throws IOException {
        StringWriter xmlContainer = new StringWriter();
        renderer.render(EWADL_TEMPLATE, xmlContainer);
        return Response.ok(xmlContainer.toString()).build();
    }

}
