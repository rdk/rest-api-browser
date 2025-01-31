package com.atlassian.labs.restbrowser.rest.services;

import com.atlassian.annotations.security.AnonymousSiteAccess;
import com.atlassian.labs.restbrowser.plugin.SoapService;
import com.atlassian.labs.restbrowser.provider.SoapServiceProvider;
import com.atlassian.labs.restbrowser.rest.model.JsonRpcMethod;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.templaterenderer.TemplateRenderer;
import com.thoughtworks.paranamer.CachingParanamer;
import com.thoughtworks.paranamer.Paranamer;

import jakarta.inject.Inject;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.io.IOException;
import java.io.StringWriter;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Provides services to present a REST-like interface over the JSON-RPC services.
 */
@Path("/jsonrpc")
public class JsonRpcResource {

    private final PluginAccessor pluginAccessor;
    private final TemplateRenderer renderer;
    private final SoapServiceProvider soapServiceProvider;
    private final ApplicationProperties applicationProperties;

    private final Paranamer paranamer = new CachingParanamer();

    @Inject
    public JsonRpcResource(PluginAccessor pluginAccessor, TemplateRenderer renderer,
                           SoapServiceProvider soapServiceProvider,
                           ApplicationProperties applicationProperties) {
        this.pluginAccessor = pluginAccessor;
        this.renderer = renderer;
        this.soapServiceProvider = soapServiceProvider;
        this.applicationProperties = applicationProperties;
    }

    @GET
    @Path("/{pluginKey}/wadl")
    @Produces(MediaType.APPLICATION_XML)
    @AnonymousSiteAccess
    public Response getWadlForService(@PathParam("pluginKey") String pluginKey) throws IOException {
        Plugin plugin = pluginAccessor.getEnabledPlugin(pluginKey);
        if (plugin == null) {
            return Response.status(Response.Status.NOT_FOUND).build();
        }

        Map<String, Object> context = new HashMap<>();

        List<JsonRpcMethod> jsonRpcMethods = new ArrayList<>();
        for (SoapService soap: soapServiceProvider.getSoapServices()) {
            if (soap.getPluginKey().equals(pluginKey)) {

                StringBuilder resourceBase = new StringBuilder();
                resourceBase.append(applicationProperties.getBaseUrl());
                resourceBase.append("/rpc/json-rpc/");
                context.put("resourceBase", resourceBase.toString() + soap.getServicePath());
                context.put("applicationProperties",applicationProperties);

                Class<?> soapInterface = soap.getPublishedInterface();
                for (Method method: soapInterface.getMethods()) {
                    JsonRpcMethod.Builder builder = new JsonRpcMethod.Builder();
                    builder.name(method.getName());
                    Class<?>[] types = method.getParameterTypes();
                    if (method.getParameterTypes().length > 0) {
                        String[] names = paranamer.lookupParameterNames(method);
                        for (int i = 0; i < types.length; i++) {
                            String name = i < names.length ? names[i] : "name missing";
                            builder.addParameter(name, convertClassToXmlnsType(types[i]));
                        }
                    }
                    jsonRpcMethods.add(builder.build());
                }
                context.put("methods", jsonRpcMethods);
                break;
            }
        }

        StringWriter xmlContainer = new StringWriter();
        renderer.render("/templates/jsonrpc-wadl.vm", context, xmlContainer);
        return Response.ok(xmlContainer.toString()).build();
    }

    private String convertClassToXmlnsType(Class clazz) {
        String name = clazz.getSimpleName();
        if (name.equals("Long") || name.equals("Integer") || name.equals(("Number"))) {
            return "long";
        } else {
            return "string";
        }
    }
}
