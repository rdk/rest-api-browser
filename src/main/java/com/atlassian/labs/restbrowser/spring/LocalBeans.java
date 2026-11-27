package com.atlassian.labs.restbrowser.spring;

import com.atlassian.event.api.EventPublisher;
import com.atlassian.labs.restbrowser.catalog.CatalogService;
import com.atlassian.labs.restbrowser.catalog.JerseyModelSource;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery;
import com.atlassian.labs.restbrowser.catalog.OperationDetails;
import com.atlassian.labs.restbrowser.catalog.OperationSource;
import com.atlassian.labs.restbrowser.catalog.ProductAdapter;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.plugin.PluginInformation;
import com.atlassian.plugin.metadata.PluginMetadataManager;
import com.atlassian.plugin.servlet.ServletModuleManager;
import com.atlassian.sal.api.ApplicationProperties;
import org.osgi.framework.Bundle;
import org.osgi.framework.BundleContext;
import org.osgi.framework.FrameworkUtil;
import org.osgi.framework.ServiceReference;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.lang.reflect.Method;
import java.util.List;

@Configuration
public class LocalBeans {

    public static final String PLUGIN_KEY = "com.atlassian.labs.rest-api-browser";
    public static final String LIVE_SCALPEL_KEY = "com.github.rdk.live-scalpel";

    public static String pluginVersion(PluginAccessor pluginAccessor) {
        if (pluginAccessor == null) {
            return "";
        }
        try {
            Plugin own = pluginAccessor.getPlugin(PLUGIN_KEY);
            PluginInformation info = own == null ? null : own.getPluginInformation();
            String version = info == null ? null : info.getVersion();
            return version == null ? "" : version.trim();
        } catch (RuntimeException | LinkageError e) {
            return "";
        }
    }

    /** Returns true when the companion Live Scalpel JVM diagnostic plugin is installed and enabled. */
    public static boolean isLiveScalpelEnabled(PluginAccessor pluginAccessor) {
        if (pluginAccessor == null) {
            return false;
        }
        try {
            return pluginAccessor.isPluginEnabled(LIVE_SCALPEL_KEY);
        } catch (RuntimeException | LinkageError e) {
            return false;
        }
    }

    /**
     * Best-effort cluster node identifier read reflectively from Jira or Confluence OSGi {@code ClusterManager}
     * services without adding compile-time product dependencies. Returns {@code null} on single-node or test hosts.
     */
    public static String clusterNodeId() {
        try {
            Bundle bundle = FrameworkUtil.getBundle(LocalBeans.class);
            BundleContext bc = bundle == null ? null : bundle.getBundleContext();
            if (bc == null) {
                return null;
            }
            String jiraNode = readClusterServiceNodeId(bc, "com.atlassian.jira.cluster.ClusterManager", false);
            if (jiraNode != null) {
                return jiraNode;
            }
            return readClusterServiceNodeId(bc, "com.atlassian.confluence.cluster.ClusterManager", true);
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static String readClusterServiceNodeId(BundleContext bc, String className, boolean confluenceStyle) {
        ServiceReference<?> ref = null;
        try {
            ref = bc.getServiceReference(className);
            if (ref == null) {
                return null;
            }
            Object svc = bc.getService(ref);
            if (svc == null) {
                return null;
            }
            if (!confluenceStyle) {
                Method m = svc.getClass().getMethod("getNodeId");
                Object raw = m.invoke(svc);
                String id = raw == null ? "" : String.valueOf(raw).trim();
                return id.isEmpty() ? null : id;
            }
            Object nodeInfo = svc.getClass().getMethod("getThisNodeInformation").invoke(svc);
            if (nodeInfo == null) {
                return null;
            }
            Object raw = nodeInfo.getClass().getMethod("getAnonymizedNodeIdentifier").invoke(nodeInfo);
            String id = raw == null ? "" : String.valueOf(raw).trim();
            return id.isEmpty() ? null : id;
        } catch (Throwable ignored) {
            return null;
        } finally {
            if (ref != null) {
                try {
                    bc.ungetService(ref);
                } catch (Throwable ignored) {
                }
            }
        }
    }

    @Bean
    public ServletContextHolder servletContextHolder() {
        return new ServletContextHolder();
    }

    @Bean
    public ModuleDiscovery moduleDiscovery(PluginAccessor pluginAccessor) {
        return new ModuleDiscovery(pluginAccessor);
    }

    @Bean
    public ProductAdapter productAdapter(ApplicationProperties applicationProperties,
                                         PluginMetadataManager pluginMetadataManager) {
        return new ProductAdapter(applicationProperties, () -> pluginMetadataManager);
    }

    @Bean
    public JerseyModelSource jerseyModelSource(ServletModuleManager servletModuleManager,
                                               ServletContextHolder servletContextHolder) {
        return new JerseyModelSource(() -> servletModuleManager, servletContextHolder::get);
    }

    @Bean
    public CatalogService catalogService(ModuleDiscovery discovery, JerseyModelSource jersey,
                                         ProductAdapter productAdapter, EventPublisher eventPublisher,
                                         PluginAccessor pluginAccessor, ServletContextHolder servletContextHolder) {
        return new CatalogService(discovery, List.of(jersey), productAdapter, eventPublisher,
                () -> {
                    String ver = pluginVersion(pluginAccessor);
                    return ver.isEmpty() ? "unknown" : ver;
                },
                servletContextHolder);
    }

    @Bean
    public OperationDetails operationDetails(ModuleDiscovery discovery, JerseyModelSource jersey,
                                             ProductAdapter productAdapter) {
        return new OperationDetails(discovery, () -> jersey, productAdapter);
    }

    @Bean
    public OperationSource operationSource(ModuleDiscovery discovery, JerseyModelSource jersey,
                                           PluginAccessor pluginAccessor, ProductAdapter productAdapter) {
        return new OperationSource(discovery, () -> jersey, pluginAccessor, productAdapter);
    }
}
