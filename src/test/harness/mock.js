/* Offline mock backend for src/test/harness/index.html; intercepts /ctx/... fetch requests. */
(function () {
  'use strict';

  var CTX = '/ctx';
  var RAB_PREFIX = CTX + '/rest/restbrowser/1';
  var realFetch = window.fetch.bind(window);
  var params = new URLSearchParams(window.location.search);
  var failMode = params.get('fail') || '';
  var liveScalpel = params.get('scalpel') !== '0';
  var sysadmin = failMode !== 'system-admin-only';
  var HASH = 'mock-hash-001';

  var LONG_TRACE_VALUE = 'L'.repeat(10600);

  var MODULES = [
    {
      id: 'jira:api2',
      path: 'api/2',
      origin: 'product',
      stability: 'supported',
      source: 'jersey',
      state: 'ok',
      opCount: 4,
      plugin: { key: 'com.atlassian.jira.rest', name: 'Jira REST Plugin', version: '11.3.13' },
    },
    {
      id: 'com.example.app:internal',
      path: 'internal/1',
      origin: 'app',
      stability: 'internal',
      source: 'jersey',
      state: 'ok',
      opCount: 1,
      plugin: { key: 'com.example.app', name: 'Example App', version: '1.0.0' },
    },
  ];

  var OPERATIONS = [
    {
      key: 'jira:api2:GET:serverInfo',
      module: 'jira:api2',
      method: 'GET',
      path: 'serverInfo',
      consumes: [],
      produces: ['application/json'],
      params: [],
      summary: 'Get mock server info',
      description: 'Returns server metadata and a large diagnostic field for testing View full and Wrap.',
      returnType: 'ServerInfoBean',
      returnJavaType: 'com.example.ServerInfoBean',
    },
    {
      key: 'jira:api2:GET:issue/{}',
      module: 'jira:api2',
      method: 'GET',
      path: 'issue/{id}',
      consumes: [],
      produces: ['application/json'],
      params: [
        { name: 'id', in: 'path', type: 'String', javaType: 'java.lang.String', required: true, description: 'Issue key' },
        { name: 'fields', in: 'query', type: 'String', javaType: 'java.lang.String', required: false, description: 'Comma-separated fields' },
      ],
      summary: 'Get issue by key',
      returnType: 'IssueBean',
      returnJavaType: 'com.example.IssueBean',
    },
    {
      key: 'jira:api2:POST:issue',
      module: 'jira:api2',
      method: 'POST',
      path: 'issue',
      consumes: ['application/json'],
      produces: ['application/json'],
      params: [],
      bodyType: 'com.example.CreateIssueRequest',
      bodyJavaType: 'com.example.CreateIssueRequest',
      summary: 'Create mock issue',
      returnType: 'IssueBean',
      returnJavaType: 'com.example.IssueBean',
    },
    {
      key: 'jira:api2:POST:upload',
      module: 'jira:api2',
      method: 'POST',
      path: 'upload',
      consumes: ['application/x-www-form-urlencoded'],
      produces: ['application/json'],
      params: [
        { name: 'comment', in: 'form', type: 'String', javaType: 'java.lang.String', required: false, description: 'Comment text' },
      ],
      summary: 'Post mock form comment',
    },
    {
      key: 'com.example.app:internal:GET:ping',
      module: 'com.example.app:internal',
      method: 'GET',
      path: 'ping',
      consumes: [],
      produces: ['application/json'],
      params: [],
      summary: 'Internal health ping',
    },
  ];

  var RESOURCE_SOURCE = [
    'package com.example;',
    '',
    'import javax.ws.rs.GET;',
    'import javax.ws.rs.Path;',
    'import javax.ws.rs.Produces;',
    'import javax.ws.rs.core.Response;',
    '',
    '@Path("serverInfo")',
    'public class ServerInfoResource {',
    '    private final ServerInfoService service;',
    '',
    '    public ServerInfoResource(ServerInfoService service) {',
    '        this.service = service;',
    '    }',
    '',
    '    @GET',
    '    @Produces("application/json")',
    '    public Response getServerInfo() {',
    '        return Response.ok(service.buildInfo()).build();',
    '    }',
    '}',
  ].join('\n');

  var SERVICE_SOURCE = [
    'package com.example;',
    '',
    'public interface ServerInfoService {',
    '    String buildInfo();',
    '}',
  ].join('\n');

  var IMPL_SOURCE = [
    'package com.example;',
    '',
    'public class DefaultServerInfoService implements ServerInfoService {',
    '    @Override',
    '    public String buildInfo() {',
    '        return "ok";',
    '    }',
    '}',
  ].join('\n');

  var STATUS_TEXT = {
    200: 'OK',
    201: 'Created',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
  };

  function jsonResponse(obj, status) {
    var code = status || 200;
    return Promise.resolve(new Response(JSON.stringify(obj), {
      status: code,
      statusText: STATUS_TEXT[code] || '',
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        'X-Node-Id': 'MOCK-NODE-1',
      },
    }));
  }

  function makeDetails(opKey) {
    var found = OPERATIONS.find(function (o) { return o.key === opKey; }) || OPERATIONS[0];
    var mod = MODULES.find(function (m) { return m.id === found.module; }) || MODULES[0];
    return {
      format: 1,
      key: found.key,
      method: {
        class: 'com.example.ServerInfoResource',
        name: found.method === 'POST' ? 'createOrPost' : 'getServerInfo',
        signature: 'public Response getServerInfo()',
        modifiers: 'public',
        returns: 'javax.ws.rs.core.Response',
        throws: [],
        annotations: ['@javax.ws.rs.' + found.method],
        deprecated: false,
        parameters: found.params.map(function (p) {
          return { name: p.name, type: p.javaType || p.type, annotations: [] };
        }),
      },
      locators: [],
      resourceClass: {
        name: 'com.example.ServerInfoResource',
        kind: 'class',
        modifiers: 'public',
        superclasses: ['java.lang.Object'],
        interfaces: [],
        annotations: ['@javax.ws.rs.Path("serverInfo")'],
        package: 'com.example',
        packageAnnotations: [],
        codeSource: 'file:/opt/atlassian/jira/plugins/jira-rest-plugin.jar',
        classLoader: 'BundleDelegatingClassLoader[com.atlassian.jira.rest]',
      },
      types: [
        { name: 'com.example.ServerInfoService', from: 'field' },
        { name: 'com.example.CreateIssueRequest', from: 'parameter' },
      ],
      bundle: {
        id: 42,
        symbolicName: mod.plugin.key,
        version: mod.plugin.version,
        state: 'ACTIVE',
        location: 'reference:file:/opt/atlassian/jira/plugins/' + mod.plugin.key + '.jar',
        lastModified: 1730000000000,
        headers: { 'Bundle-SymbolicName': mod.plugin.key },
        importCount: 1,
        exportCount: 1,
        imports: [{ package: 'javax.ws.rs', version: '2.1.6', from: 'org.apache.felix.framework' }],
        exports: [{ package: 'com.example', version: '1.0.0', users: 2 }],
      },
      plugin: {
        key: mod.plugin.key,
        name: mod.plugin.name,
        version: mod.plugin.version,
        origin: mod.origin,
        state: 'ENABLED',
        pluginsVersion: 2,
        dependsOn: [],
        optionallyDependsOn: [],
        moduleCount: 1,
        modules: [{ key: 'rest-api', type: 'rest', name: mod.path, enabled: true }],
      },
      module: {
        key: 'rest-api',
        path: mod.path,
        basePath: '/rest/' + mod.path,
        version: '2',
        rest: 'rest-v2',
        descriptor: 'atlassian-plugin.xml',
      },
    };
  }

  function makeClassInfo(cls) {
    var name = cls || 'com.example.ServerInfoResource';
    var parts = name.split('.');
    var simple = parts[parts.length - 1];
    var pkg = parts.slice(0, -1).join('.') || 'default';
    return {
      format: 1,
      name: name,
      simpleName: simple,
      package: pkg,
      kind: name.indexOf('Service') >= 0 && name.indexOf('Default') < 0 ? 'interface' : 'class',
      modifiers: 'public',
      deprecated: false,
      superclasses: ['java.lang.Object'],
      interfaces: name.indexOf('DefaultServerInfoService') >= 0 ? ['com.example.ServerInfoService'] : [],
      annotations: name.indexOf('Resource') >= 0 ? ['@Path("serverInfo")'] : [],
      innerClasses: [],
      fieldCount: 1,
      constructorCount: 1,
      methodCount: 1,
      methods: [name.indexOf('Service') >= 0 ? 'String buildInfo()' : 'Response getServerInfo()'],
      bytecodeVersion: 'Java 21',
      bytecodeMajor: 65,
      bytecodeBytes: 1420,
      codeSource: 'file:/opt/atlassian/jira/plugins/jira-rest-plugin.jar',
      classLoader: 'BundleDelegatingClassLoader[com.atlassian.jira.rest]',
      origin: 'product',
      bundleId: 42,
      refCount: 1,
      refs: name.indexOf('Resource') >= 0 ? ['com.example.ServerInfoService'] : ['com.example.ServerInfoResource'],
      inspectMs: 2,
      cached: false,
    };
  }

  function makeSource(cls, decompiler) {
    var name = cls || 'com.example.ServerInfoResource';
    var decId = decompiler === 'cfr' ? 'cfr' : 'vineflower';
    var decName = decId === 'cfr' ? 'CFR 0.152' : 'Vineflower 1.11.1';
    var source = RESOURCE_SOURCE;
    var refs = ['com.example.ServerInfoService'];
    if (name.indexOf('DefaultServerInfoService') >= 0) {
      source = IMPL_SOURCE;
      refs = ['com.example.ServerInfoService'];
    } else if (name.indexOf('ServerInfoService') >= 0) {
      source = SERVICE_SOURCE;
      refs = ['com.example.ServerInfoResource'];
    }
    var lines = source.split('\n').length;
    return {
      format: 1,
      class: name,
      scope: 'class',
      decompilerId: decId,
      decompiler: decName,
      bundleId: 42,
      totalLines: lines,
      startLine: 1,
      endLine: lines,
      truncated: false,
      methodLine: name.indexOf('Resource') >= 0 ? 18 : 1,
      decompileMs: 8,
      cached: false,
      source: source,
      refs: refs,
    };
  }

  function routeRabApi(sub, url, method, init) {
    var sp = url.searchParams;

    if (sub === '/catalog' && method === 'GET') {
      return jsonResponse({
        format: 1,
        product: { name: 'Jira', version: '11.3.13', build: '11030014' },
        baseUrl: CTX,
        nodeId: 'MOCK-NODE-1',
        hash: HASH,
        complete: true,
        progress: { done: 2, total: 2 },
        admin: true,
        sysadmin: sysadmin,
        liveScalpel: liveScalpel,
        modules: MODULES,
      });
    }

    if (sub.indexOf('/catalog/index/') === 0 && method === 'GET') {
      return jsonResponse({ format: 1, hash: HASH, operations: OPERATIONS });
    }

    if (sub === '/catalog/openapi' && method === 'GET') {
      var modId = sp.get('module') || 'jira:api2';
      return jsonResponse({
        openapi: '3.1.0',
        info: { title: modId, version: '11.3.13' },
        paths: {
          '/rest/api/2/serverInfo': {
            get: { summary: 'Get mock server info', responses: { '200': { description: 'OK' } } },
          },
        },
      });
    }

    if (sub === '/echo') {
      return jsonResponse({
        method: method,
        headers: [['Accept', 'application/json'], ['X-Mock-Harness', 'true']],
      });
    }

    var isSysadminOnly = sub.indexOf('/code/') === 0 || sub === '/catalog/details' || sub === '/catalog/details/source';
    if (isSysadminOnly && !sysadmin) {
      return jsonResponse({ error: 'system-admin-only', hint: 'Requires SYSTEM_ADMIN.' }, 403);
    }

    if (sub === '/catalog/details' && method === 'GET') {
      return jsonResponse(makeDetails(sp.get('op') || OPERATIONS[0].key));
    }

    if ((sub === '/catalog/details/source' || sub === '/code/source') && method === 'GET') {
      var cls = (sp.get('class') || '').split(',')[0] || 'com.example.ServerInfoResource';
      return jsonResponse(makeSource(cls, sp.get('decompiler')));
    }

    if (sub === '/code/class' && method === 'GET') {
      var clsName = (sp.get('class') || '').split(',')[0] || 'com.example.ServerInfoResource';
      return jsonResponse(makeClassInfo(clsName));
    }

    if (sub === '/code/schema' && method === 'GET') {
      return jsonResponse({
        format: 1,
        key: sp.get('op') || 'jira:api2:POST:issue',
        requestBody: {
          javaType: 'com.example.CreateIssueRequest',
          typesVisited: 1,
          truncated: false,
          schema: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              priority: { type: 'string' },
            },
          },
          example: { summary: 'Mock issue summary', priority: 'High' },
        },
      });
    }

    if (sub === '/code/implementations' && method === 'GET') {
      return jsonResponse({
        format: 1,
        target: sp.get('class') || 'com.example.ServerInfoResource',
        kind: 'class',
        bundleId: 42,
        scannedBundles: 2,
        truncated: false,
        elapsedMs: 3,
        serviceCount: 1,
        osgiServices: [
          {
            serviceId: 101,
            bundleId: 42,
            bundle: 'com.atlassian.jira.rest',
            plugin: 'com.atlassian.jira.rest',
            beanName: 'serverInfoService',
            ranking: 0,
            objectClass: ['com.example.ServerInfoService'],
          },
        ],
        implementationCount: 1,
        implementations: [
          {
            class: 'com.example.DefaultServerInfoService',
            simpleName: 'DefaultServerInfoService',
            kind: 'class',
            abstract: false,
            bundleId: 42,
            bundle: 'com.atlassian.jira.rest',
            plugin: 'com.atlassian.jira.rest',
            via: 'implements',
          },
        ],
      });
    }

    if (sub === '/code/callers' && method === 'GET') {
      return jsonResponse({
        format: 1,
        target: sp.get('class') || 'com.example.ServerInfoResource',
        bundleId: 42,
        count: 1,
        scannedClasses: 24,
        scannedBundles: 2,
        truncated: false,
        elapsedMs: 4,
        results: [
          {
            class: 'com.example.HealthCheckServlet',
            simpleName: 'HealthCheckServlet',
            bundleId: 42,
            plugin: 'com.atlassian.jira.rest',
            calls: ['doGet() -> getServerInfo()'],
          },
        ],
      });
    }

    if (sub === '/code/grep' && method === 'GET') {
      return jsonResponse({
        format: 1,
        query: sp.get('q') || '',
        caseSensitive: false,
        includeUtf8: true,
        count: 1,
        scannedClasses: 18,
        scannedBundles: 2,
        truncated: false,
        elapsedMs: 5,
        results: [
          {
            class: 'com.example.ServerInfoResource',
            simpleName: 'ServerInfoResource',
            bundleId: 42,
            plugin: 'com.atlassian.jira.rest',
            matches: ['string: "serverInfo"'],
          },
        ],
      });
    }

    if (sub === '/code/resource' && method === 'GET') {
      var resPath = sp.get('path');
      if (resPath) {
        return jsonResponse({
          format: 1,
          bundleId: 42,
          bundle: 'com.atlassian.jira.rest',
          plugin: 'com.atlassian.jira.rest',
          path: resPath,
          kind: 'xml',
          bytes: 58,
          totalLines: 1,
          startLine: 1,
          endLine: 1,
          truncated: false,
          content: '<atlassian-plugin key="com.atlassian.jira.rest" name="Mock"/>',
        });
      }
      return jsonResponse({
        format: 1,
        bundleId: 42,
        bundle: 'com.atlassian.jira.rest',
        plugin: 'com.atlassian.jira.rest',
        count: 1,
        truncated: false,
        entries: [{ path: 'atlassian-plugin.xml', kind: 'xml' }],
      });
    }

    return jsonResponse({ error: 'not-found', path: sub }, 404);
  }

  function routeProductRest(pathname, method, init) {
    if (pathname === CTX + '/rest/api/2/serverInfo') {
      return jsonResponse({
        baseUrl: CTX,
        version: '11.3.13',
        serverTitle: 'Mock Jira Data Center',
        nodeId: 'MOCK-NODE-1',
        longTracePayload: LONG_TRACE_VALUE,
      });
    }
    if (pathname.indexOf(CTX + '/rest/api/2/issue/') === 0 && method === 'GET') {
      var id = decodeURIComponent(pathname.slice((CTX + '/rest/api/2/issue/').length));
      return jsonResponse({ id: id, status: 'mock-ok' });
    }
    if (pathname === CTX + '/rest/api/2/issue' && method === 'POST') {
      var rawBody = (init && typeof init.body === 'string') ? init.body : '';
      var parsed = null;
      try { parsed = rawBody ? JSON.parse(rawBody) : null; } catch (_e) { parsed = rawBody; }
      return jsonResponse({ id: 'MOCK-101', created: true, received: parsed }, 201);
    }
    if (pathname === CTX + '/rest/api/2/upload' && method === 'POST') {
      return jsonResponse({ uploaded: true });
    }
    if (pathname === CTX + '/rest/internal/1/ping') {
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ error: 'mock-endpoint-not-found', path: pathname }, 404);
  }

  window.fetch = function (input, init) {
    var rawUrl = typeof input === 'string' ? input : (input && input.url) || '';
    var url;
    try {
      url = new URL(rawUrl, window.location.origin);
    } catch (_e) {
      return realFetch(input, init);
    }
    if (url.pathname.indexOf(CTX + '/') !== 0) {
      return realFetch(input, init);
    }

    var method = ((init && init.method) || (typeof input !== 'string' && input && input.method) || 'GET').toUpperCase();

    if (url.pathname.indexOf(CTX + '/rest/') === 0) {
      if (failMode === 'network') {
        return Promise.reject(new TypeError('Mock network failure'));
      }
      if (failMode === 'login-required') {
        return jsonResponse({ error: 'login-required', message: 'Authentication required' }, 401);
      }
    }

    if (url.pathname.indexOf(RAB_PREFIX + '/') === 0) {
      return routeRabApi(url.pathname.slice(RAB_PREFIX.length), url, method, init);
    }
    return routeProductRest(url.pathname, method, init);
  };
})();
