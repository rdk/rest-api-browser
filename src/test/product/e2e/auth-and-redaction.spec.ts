import { request as playwrightRequest } from '@playwright/test';
import { expect, getProductConfig, openNewUi, openOperation, test } from './fixtures';

test.describe('Authentication boundaries and header redaction', () => {
  test('rejects anonymous access to plugin servlets, catalog, code, and MCP endpoints', async ({ product }) => {
    const anon = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });
    try {
      for (const path of [
        '/plugins/servlet/rest-api-browser',
        '/plugins/servlet/rest-api-browser/admin',
        '/plugins/servlet/restbrowser',
      ]) {
        const res = await anon.get(product.url(path), { maxRedirects: 0 });
        expect([301, 302, 303, 307, 401, 403], `unexpected status ${res.status()} for anonymous ${path}`).toContain(res.status());
      }

      const catRes = await anon.get(product.url('/rest/restbrowser/1/catalog'), { maxRedirects: 0 });
      expect([401, 403]).toContain(catRes.status());

      const codeRes = await anon.get(product.url('/rest/restbrowser/1/code/search?q=Server'), { maxRedirects: 0 });
      expect([401, 403]).toContain(codeRes.status());

      const mcpRes = await anon.post(product.url('/rest/restbrowser/1/mcp'), {
        maxRedirects: 0,
        headers: { 'Content-Type': 'application/json' },
        data: { jsonrpc: '2.0', id: 1, method: 'ping' },
      });
      expect([401, 403]).toContain(mcpRes.status());
    } finally {
      await anon.dispose();
    }
  });

  test('redacts secret headers in /echo and browser Request headers tab', async ({ rabApi, rabPage, product }) => {
    const cfg = getProductConfig();
    const echoRes = await rabApi.get(product.url('/rest/restbrowser/1/echo'), {
      headers: {
        Cookie: 'JSESSIONID=pw-secret-cookie-val',
        'X-Api-Key': 'pw-secret-api-key',
      },
    });
    expect(echoRes.status()).toBe(200);
    const echoText = await echoRes.text();
    expect(echoText).toContain('JSESSIONID=');
    expect(echoText).not.toContain('pw-secret-cookie-val');
    expect(echoText).not.toContain('pw-secret-api-key');
    if (cfg.password.length >= 4) {
      expect(echoText).not.toContain(cfg.password);
    }

    await openNewUi(rabPage, product);
    await openOperation(rabPage, product.search, product.title, 'GET');
    await rabPage.getByTestId('send').click();
    await expect(rabPage.getByTestId('response-status')).toContainText(/^200\b/, { timeout: 25_000 });

    await rabPage.getByRole('tab', { name: 'Request headers' }).click();
    const reqHeaders = rabPage.getByTestId('request-headers');
    await expect(reqHeaders).toBeVisible();
    await expect(reqHeaders).not.toContainText('Asking the server what it receives…', { timeout: 20_000 });

    const renderedText = (await reqHeaders.textContent()) || '';
    expect(renderedText).not.toContain(cfg.authHeader.slice('Basic '.length));
    if (cfg.password.length >= 4) {
      expect(renderedText).not.toContain(cfg.password);
    }
  });
});
