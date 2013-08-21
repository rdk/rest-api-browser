package com.atlassian.labs.restbrowser.rest.services;

import com.atlassian.labs.restbrowser.plugin.SoapService;
import com.atlassian.labs.restbrowser.provider.SoapServiceProvider;
import com.atlassian.labs.restbrowser.rest.model.JsonRpcMethod;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.templaterenderer.TemplateRenderer;
import com.google.common.collect.Lists;
import com.google.common.collect.Maps;
import com.thoughtworks.paranamer.CachingParanamer;
import com.thoughtworks.paranamer.Paranamer;

import javax.ws.rs.*;
import javax.ws.rs.core.MediaType;
import javax.ws.rs.core.Response;
import java.io.IOException;
import java.io.StringWriter;
import java.lang.reflect.Method;
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
    public Response getWadlForService(@PathParam("pluginKey") String pluginKey) throws IOException {
        Plugin plugin = pluginAccessor.getEnabledPlugin(pluginKey);
        if (plugin == null) {
            return Response.status(Response.Status.NOT_FOUND).build();
        }

        Map<String, Object> context = Maps.newHashMap();

        List<JsonRpcMethod> jsonRpcMethods = Lists.newArrayList();
        for (SoapService soap: soapServiceProvider.getSoapServices()) {
            if (soap.getPluginKey().equals(pluginKey)) {

                StringBuilder resourceBase = new StringBuilder();
                resourceBase.append(applicationProperties.getBaseUrl());
                resourceBase.append("/rpc/json-rpc/");
                context.put("resourceBase", resourceBase.toString() + soap.getServicePath());

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
