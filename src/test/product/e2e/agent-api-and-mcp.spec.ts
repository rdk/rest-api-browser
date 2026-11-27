import { expect, test } from './fixtures';

test.describe('Agent REST APIs, OpenAPI 3.1, and MCP protocol', () => {
  test('serves llms.txt, llms-full.txt, OpenAPI 3.1 specs, ETag 304, and code intelligence endpoints', async ({ rabApi, product }) => {
    const llms = await rabApi.get(product.url('/plugins/servlet/rest-api-browser/llms.txt'));
    expect(llms.status()).toBe(200);
    const llmsText = await llms.text();
    expect(llmsText).toMatch(/^# REST API Browser/);
    expect(llmsText).toContain('/catalog/operations');
    expect(llmsText).toContain('/code/context');
    expect(llmsText).toContain('/mcp');

    const llmsFull = await rabApi.get(product.url('/plugins/servlet/rest-api-browser/llms-full.txt'));
    expect(llmsFull.status()).toBe(200);
    expect(await llmsFull.text()).toContain('Full Agent Reference');

    const brief1 = await rabApi.get(product.url('/rest/restbrowser/1/catalog/brief?top=5'));
    expect(brief1.status()).toBe(200);
    expect(await brief1.text()).toContain('top modules');
    const briefTag = brief1.headers()['etag'];
    expect(briefTag).toBeTruthy();
    const brief304 = await rabApi.get(product.url('/rest/restbrowser/1/catalog/brief?top=5'), {
      headers: { 'If-None-Match': briefTag },
    });
    expect(brief304.status()).toBe(304);

    for (const p of ['/rest/restbrowser/1/openapi', '/rest/restbrowser/1/openapi.json']) {
      const res = await rabApi.get(product.url(p));
      expect(res.status()).toBe(200);
      const doc = (await res.json()) as { openapi?: string; paths?: Record<string, unknown> };
      expect(doc.openapi).toBe('3.1.0');
      expect(Object.keys(doc.paths || {}).length).toBeGreaterThan(5);
    }

    const opsRes = await rabApi.get(product.url('/rest/restbrowser/1/catalog/operations?limit=5'));
    expect(opsRes.status()).toBe(200);
    const opsData = (await opsRes.json()) as { operations: Array<{ key: string; module: string }> };
    expect(opsData.operations.length).toBeGreaterThan(0);
    const sampleOp = opsData.operations[0];

    const clsRes = await rabApi.get(product.url(`/rest/restbrowser/1/code/operation?op=${encodeURIComponent(sampleOp.key)}&maxLines=25&format=json`));
    expect(clsRes.status()).toBe(200);
    const opDetails = (await clsRes.json()) as { details?: { method?: { class?: string } } };
    const fqcn = opDetails.details?.method?.class;
    expect(fqcn).toBeTruthy();

    const meta1 = await rabApi.get(product.url(`/rest/restbrowser/1/code/class?class=${encodeURIComponent(fqcn!)}&view=compact&outline=true`));
    expect(meta1.status()).toBe(200);
    const etag = meta1.headers()['etag'];
    expect(etag).toBeTruthy();

    const meta304 = await rabApi.get(product.url(`/rest/restbrowser/1/code/class?class=${encodeURIComponent(fqcn!)}&view=compact&outline=true`), {
      headers: { 'If-None-Match': etag },
    });
    expect(meta304.status()).toBe(304);

    const modSpec = await rabApi.get(product.url(`/rest/restbrowser/1/catalog/openapi?module=${encodeURIComponent(sampleOp.module)}&includeSchemas=false`));
    expect(modSpec.status()).toBe(200);
    expect(((await modSpec.json()) as { openapi?: string }).openapi).toBe('3.1.0');
  });

  test('supports MCP initialize, tools/*, resources/*, and prompts/* over JSON-RPC 2.0', async ({ rabApi, product }) => {
    const mcpUrl = product.url('/rest/restbrowser/1/mcp');
    const postMcp = (payload: Record<string, unknown>) =>
      rabApi.post(mcpUrl, {
        headers: {
          'Content-Type': 'application/json',
          'X-Atlassian-Token': 'no-check',
        },
        data: payload,
      });

    const init = await postMcp({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(init.status()).toBe(200);
    const initJson = (await init.json()) as { result: { protocolVersion: string; capabilities: Record<string, unknown> } };
    expect(initJson.result.protocolVersion).toBe('2025-03-26');
    expect(initJson.result.capabilities).toHaveProperty('tools');
    expect(initJson.result.capabilities).toHaveProperty('resources');
    expect(initJson.result.capabilities).toHaveProperty('prompts');

    const notif = await postMcp({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notif.status()).toBe(202);

    const tools = (await (await postMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(tools.result.tools.length).toBeGreaterThanOrEqual(10);

    const resList = (await (await postMcp({ jsonrpc: '2.0', id: 3, method: 'resources/list' })).json()) as {
      result: { resources: Array<{ uri: string }> };
    };
    const uris = resList.result.resources.map((r) => r.uri);
    expect(uris).toContain('rab://llms.txt');
    expect(uris).toContain('rab://catalog/brief');

    const briefTool = (await (await postMcp({
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: { name: 'get_catalog_summary', arguments: { format: 'brief', maxChars: 240 } },
    })).json()) as { result: { content: Array<{ text: string }> } };
    expect(briefTool.result.content[0].text.length).toBeLessThanOrEqual(240);

    const resRead = (await (await postMcp({
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/read',
      params: { uri: 'rab://openapi/self' },
    })).json()) as { result: { contents: Array<{ text: string }> } };
    expect(JSON.parse(resRead.result.contents[0].text).openapi).toBe('3.1.0');

    const prompts = (await (await postMcp({ jsonrpc: '2.0', id: 5, method: 'prompts/list' })).json()) as {
      result: { prompts: Array<{ name: string }> };
    };
    expect(prompts.result.prompts.map((p) => p.name)).toContain('debug-stuck-endpoint');

    const promptGet = (await (await postMcp({
      jsonrpc: '2.0',
      id: 6,
      method: 'prompts/get',
      params: { name: 'debug-stuck-endpoint', arguments: { target: '/rest/pw-probe' } },
    })).json()) as { result: { messages: Array<{ content: { text: string } }> } };
    expect(promptGet.result.messages[0].content.text).toContain('/rest/pw-probe');
  });
});
