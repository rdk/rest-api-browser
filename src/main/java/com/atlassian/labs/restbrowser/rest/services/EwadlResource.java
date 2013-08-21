package com.atlassian.labs.restbrowser.rest.services;

import com.atlassian.plugins.rest.common.security.AnonymousAllowed;
import com.atlassian.templaterenderer.TemplateRenderer;

import javax.ws.rs.GET;
import javax.ws.rs.Path;
import javax.ws.rs.Produces;
import javax.ws.rs.core.MediaType;
import javax.ws.rs.core.Response;
import java.io.IOException;
import java.io.StringWriter;

/**
 * Provides the ewadl resource.
 */
@Path("ewadl")
public class EwadlResource {

    private static final String EWADL_TEMPLATE = "/templates/ewadl.vm";

    private final TemplateRenderer renderer;

    public EwadlResource(TemplateRenderer renderer) {
        this.renderer = renderer;
    }

    @AnonymousAllowed
    @GET
    @Produces(MediaType.APPLICATION_XML)
    public Response getWadl() throws IOException {
        StringWriter xmlContainer = new StringWriter();
        renderer.render(EWADL_TEMPLATE, xmlContainer);
        return Response.ok(xmlContainer.toString()).build();
    }

}
