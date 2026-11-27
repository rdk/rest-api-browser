import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

let server: http.Server;
let baseOrigin = '';

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const cleanRel = decodeURIComponent(reqUrl.pathname).replace(/^\/+/, '');
    const resolved = path.resolve(REPO_ROOT, cleanRel);
    if (resolved !== REPO_ROOT && !resolved.startsWith(REPO_ROOT + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.stat(resolved, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404).end('Not found');
        return;
      }
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(resolved).pipe(res);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
      baseOrigin = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

test.afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

function harnessUrl(query = ''): string {
  return `${baseOrigin}/src/test/harness/index.html${query ? `?${query}` : ''}`;
}

function trackPageErrors(page: Page): string[] {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  return errs;
}

test.describe('Offline mock harness UI & code intelligence', () => {
  test('renders node badge, Trace in Scalpel, live GET with Wrap + View full, OpenAPI export, and Generate example', async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto(harnessUrl());

    await expect(page.getByTestId('search')).toBeVisible();
    await expect(page.getByTestId('node-id')).toHaveText('MOCK-NODE-1');

    // Open GET serverInfo
    await page.locator('[data-testid="op"][data-path="api/2/serverInfo"]').click();
    await expect(page.getByTestId('operation-path')).toHaveText('api/2/serverInfo');
    await expect(page.getByTestId('trace-in-scalpel')).toHaveAttribute('href', '/ctx/plugins/servlet/live-scalpel#traces');

    // Send live mock GET
    await page.getByTestId('send').click();
    await expect(page.getByTestId('response-status')).toHaveText('200 OK');

    // Wrap toggle and View full long-line dialog
    const wrapBtn = page.getByTestId('toggle-wrap');
    await wrapBtn.click();
    await expect(page.getByTestId('pretty-wrapped')).toBeVisible();
    await expect(wrapBtn).toHaveAttribute('aria-pressed', 'true');

    await page.getByTestId('view-full-line').first().click();
    await expect(page.getByTestId('full-value-dialog')).toBeVisible();
    await expect(page.getByTestId('full-value-textarea')).toHaveValue(/L{100}/);
    await page.getByTestId('full-value-close').click();
    await expect(page.getByTestId('full-value-dialog')).toHaveCount(0);

    // Export module OpenAPI 3.1 JSON
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-module-openapi').click(),
    ]);
    expect(dl.suggestedFilename()).toMatch(/^openapi-.*\.json$/);

    // Switch to POST issue and test Generate example DTO synthesis
    await page.locator('[data-testid="op"][data-method="POST"][data-path="api/2/issue"]').click();
    await page.locator('.rab-n-request [role="tab"]', { hasText: 'Body' }).click();
    await page.getByTestId('generate-example').click();
    await expect(page.getByTestId('body')).toHaveValue(/"Mock issue summary"/);
    await expect(page.getByTestId('json-check')).toContainText('Valid JSON');

    expect(errors).toEqual([]);
  });

  test('auto-opens SourceDialog via ?class=...&method=...&line=... deep-link and exercises code-intel panels, CFR, tabs, ZIP, Escape', async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto(harnessUrl('class=com.example.ServerInfoResource&method=getServerInfo&line=18&fromBundle=42'));

    const dialog = page.getByTestId('source-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('dialog-source-code')).toContainText('class ServerInfoResource');

    // Implementations panel
    await page.getByTestId('source-panel-implementations').click();
    await expect(page.getByTestId('implementations-panel')).toContainText('DefaultServerInfoService');

    // Callers panel
    await page.getByTestId('source-panel-callers').click();
    await expect(page.getByTestId('callers-panel')).toContainText('HealthCheckServlet');

    // Grep panel
    await page.getByTestId('source-panel-grep').click();
    await page.getByTestId('grep-query-input').fill('serverInfo');
    await page.getByTestId('grep-submit').click();
    await expect(page.getByTestId('grep-panel')).toContainText('ServerInfoResource');

    // Bundle resources + preview + Escape back to code
    await page.getByTestId('source-panel-resources').click();
    await page.getByTestId('bundle-resource-item').first().click();
    await expect(page.getByTestId('bundle-resource-preview')).toContainText('<atlassian-plugin');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('bundle-resource-preview')).toHaveCount(0);
    await expect(page.getByTestId('dialog-source-code')).toBeVisible();

    // Switch decompiler to CFR
    await page.getByTestId('decompiler-cfr').click();
    await expect(page.getByTestId('decompiler-cfr')).toHaveAttribute('aria-pressed', 'true');

    // Open a 2nd tab via quick-open
    await page.getByTestId('source-dialog-add').click();
    await page.locator('[data-testid="source-dialog-quickopen"] input').fill('com.example.ServerInfoService:3');
    await page.locator('[data-testid="source-dialog-quickopen"] button[type="submit"]').click();
    await expect(page.getByTestId('dialog-source-code')).toContainText('interface ServerInfoService');

    // Download all open tabs as ZIP
    const [zipDl] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('source-dialog-download-zip').click(),
    ]);
    expect(zipDl.suggestedFilename()).toMatch(/\.zip$/);

    // Escape minimizes the dialog
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('supports skins, colour modes, fullscreen inert, Supported only URL & toggle, and module fold/unfold', async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto(harnessUrl('supportedOnly=1'));

    const supportedBtn = page.getByTestId('supported-only');
    await expect(supportedBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('status')).toContainText('4 of 5 operations');

    await supportedBtn.click();
    await expect(supportedBtn).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('status')).toContainText('5 operations in 2 modules');

    const toggleModules = page.getByTestId('toggle-modules');
    await expect(toggleModules).toHaveAttribute('data-state', 'expanded');
    await toggleModules.click();
    await expect(toggleModules).toHaveAttribute('data-state', 'collapsed');
    await toggleModules.click();
    await expect(toggleModules).toHaveAttribute('data-state', 'expanded');

    // Skins + Dark mode + persistence
    await page.getByTestId('menu-button').click();
    await page.getByTestId('skin-vivid').click();
    await expect(page.locator('.rab-n')).toHaveAttribute('data-skin', 'vivid');

    await page.getByTestId('mode-dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-color-mode', 'dark');
    await page.getByTestId('mode-light').click();
    await expect(page.locator('html')).toHaveAttribute('data-color-mode', 'light');

    await page.reload();
    await expect(page.locator('.rab-n')).toHaveAttribute('data-skin', 'vivid');

    // Fullscreen inert + Escape
    await page.locator('[data-testid="op"][data-path="api/2/serverInfo"]').click();
    await page.getByTestId('max-top').click();
    await expect(page.locator('.rab-n-topbar')).toHaveAttribute('inert', '');
    await expect(page.locator('.rab-n-side')).toHaveAttribute('inert', '');
    await page.keyboard.press('Escape');
    await expect(page.locator('.rab-n-topbar')).not.toHaveAttribute('inert', '');

    expect(errors).toEqual([]);
  });

  test('handles ?fail=login-required and ?scalpel=0 cleanly', async ({ page }) => {
    const errors = trackPageErrors(page);

    await page.goto(harnessUrl('scalpel=0'));
    await page.locator('[data-testid="op"][data-path="api/2/serverInfo"]').click();
    await expect(page.getByTestId('operation-path')).toHaveText('api/2/serverInfo');
    await expect(page.getByTestId('trace-in-scalpel')).toHaveCount(0);

    await page.goto(harnessUrl('fail=login-required'));
    await expect(page.locator('[data-testid="status"] .rab-n-error')).toBeVisible();

    expect(errors).toEqual([]);
  });
});
