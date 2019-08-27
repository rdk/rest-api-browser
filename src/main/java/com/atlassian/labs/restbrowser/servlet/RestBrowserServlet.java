package com.atlassian.labs.restbrowser.servlet;

import com.atlassian.labs.restbrowser.plugin.SoapService;
import com.atlassian.labs.restbrowser.provider.SoapServiceProvider;
import com.atlassian.labs.restbrowser.rest.model.RestDescriptor;
import com.atlassian.plugin.ModuleDescriptor;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.plugin.predicate.ModuleDescriptorPredicate;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.auth.LoginUriProvider;
import com.atlassian.sal.api.user.UserManager;
import com.atlassian.templaterenderer.TemplateRenderer;
import com.google.common.collect.Lists;
import com.google.common.collect.Maps;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.servlet.http.HttpServletRequest;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;

import static com.google.common.base.Preconditions.checkNotNull;

public class RestBrowserServlet extends RequiresLoginServlet {
    private static final Logger log = LoggerFactory.getLogger(RestBrowserServlet.class);
    private static final String BROWSER_TEMPLATE = "/templates/browser.vm";

    private final PluginAccessor pluginAccessor;
    private final SoapServiceProvider soapServiceProvider;
    private final ApplicationProperties applicationProperties;

    public RestBrowserServlet(PluginAccessor pluginAccessor, SoapServiceProvider soapServiceProvider,
                              UserManager userManager,TemplateRenderer renderer, LoginUriProvider loginUriProvider,
                              ApplicationProperties applicationProperties) {
        super(userManager, renderer, loginUriProvider);
        this.applicationProperties = applicationProperties;
        this.pluginAccessor = checkNotNull(pluginAccessor, "pluginAccessor");
        this.soapServiceProvider = checkNotNull(soapServiceProvider, "soapServiceProvider");
    }

    @Override
    public Map<String, Object> getContext(HttpServletRequest req) {
        Map<String, Object> context = Maps.newHashMap();

        context.put("restDescriptors", getRestDescriptors());
        context.put("jsonRpcDescriptors", getJsonRpcDescriptors());
        context.put("devMode", System.getProperty("atlassian.dev.mode"));
        context.put("applicationProperties", applicationProperties);

        return context;
    }

    @Override
    public String getTemplatePath() {
        return BROWSER_TEMPLATE;
    }

    private List<RestDescriptor> getJsonRpcDescriptors() {
        List<RestDescriptor> jsonRpcDescriptors = Lists.newArrayList();

        Iterable<? extends SoapService> soaps = soapServiceProvider.getSoapServices();

        for (SoapService soap: soaps) {
            RestDescriptor.Builder builder = new RestDescriptor.Builder();
            Plugin plugin = soap.getPlugin();
            builder.pluginKey(plugin.getKey()).pluginCompleteKey(soap.getCompleteKey()).
                    pluginName(plugin.getName()).pluginDescription(soap.getDescription()).
                    basePath("/json-rpc").version(soap.getServicePath());
            jsonRpcDescriptors.add(builder.build());
        }

        return jsonRpcDescriptors;
    }

    private List<RestDescriptor> getRestDescriptors()
    {
        Collection<ModuleDescriptor> restServlets = pluginAccessor.getModuleDescriptors(
                new ModuleDescriptorOfClassNamePredicate("com.atlassian.plugins.rest.module.RestServletFilterModuleDescriptor"));

        List<RestDescriptor> restDescriptors = new ArrayList<RestDescriptor>(restServlets.size());

        for (ModuleDescriptor servlet : restServlets)
        {
            //com.atlassian.plugins.rest.module is exported as private and so we have to use reflection to access the concrete descriptor we want
            Class params[] = {};
            Object args[] = {};
            String basePath;
            Object apiVersion;
            String version;
            try
            {
                Method getBasePath = servlet.getClass().getMethod("getBasePath",params);
                basePath = (String)getBasePath.invoke(servlet,args);

                Method getVersion = servlet.getClass().getMethod("getVersion",params);
                apiVersion = getVersion.invoke(servlet,args);
                version = apiVersion.toString();

            } catch (Exception e)
            {
                continue;
            }


            Plugin plugin = servlet.getPlugin();

            RestDescriptor.Builder builder = new RestDescriptor.Builder().
                basePath(basePath).version(version).pluginCompleteKey(servlet.getCompleteKey()).
                pluginKey(plugin.getKey()).pluginName(plugin.getName()).pluginDescription(servlet.getDescription());


            RestDescriptor desc = builder.build();
            // log.warn(desc.toString());
            restDescriptors.add(desc);
        }

        return restDescriptors;
    }

    public class ModuleDescriptorOfClassNamePredicate<T> implements ModuleDescriptorPredicate<T>
    {
        private final String moduleDescriptorClass;

        public ModuleDescriptorOfClassNamePredicate(String targetClass)
        {
            moduleDescriptorClass = targetClass;
        }

        public boolean matches(final ModuleDescriptor<? extends T> moduleDescriptor)
        {
            return (moduleDescriptor != null) && moduleDescriptor.getClass().getName().equals(moduleDescriptorClass);
        }
    }

}