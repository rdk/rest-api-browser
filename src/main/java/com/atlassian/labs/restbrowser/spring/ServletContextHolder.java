package com.atlassian.labs.restbrowser.spring;

import jakarta.servlet.ServletContext;
import org.springframework.beans.factory.DisposableBean;

import java.util.concurrent.atomic.AtomicReference;

/**
 * Holds the web application's {@link ServletContext} captured from HTTP requests, allowing Spring beans like
 * {@link com.atlassian.labs.restbrowser.catalog.JerseyModelSource} and
 * {@link com.atlassian.labs.restbrowser.catalog.CatalogService} to wire without circular references.
 */
public final class ServletContextHolder implements DisposableBean {

    private final AtomicReference<ServletContext> context = new AtomicReference<>();

    public void setIfAbsent(ServletContext ctx) {
        if (ctx != null) {
            context.compareAndSet(null, ctx);
        }
    }

    public ServletContext get() {
        return context.get();
    }

    @Override
    public void destroy() {
        context.set(null);
    }
}
