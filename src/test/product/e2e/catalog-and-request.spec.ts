import fs from 'node:fs/promises';
import { expect, openNewUi, openOperation, test } from './fixtures';

test.describe('Catalog, requests, downloads, and forms', () => {
  test('sends live GET, toggles Pretty Wrap, and downloads response + OpenAPI 3.1', async ({ rabPage, product }) => {
    await openNewUi(rabPage, product);

    await expect(rabPage.locator('#header')).toBeHidden();
    const docOverflowY = await rabPage.evaluate(
      () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
    );
    expect(docOverflowY).toBeLessThanOrEqual(2);

    await openOperation(rabPage, product.search, product.title, 'GET');
    await rabPage.getByTestId('send').click();

    await expect(rabPage.getByTestId('response-status')).toContainText(/^200\b/, { timeout: 25_000 });
    await expect(rabPage.getByTestId('response')).toContainText(product.answerRe);

    // Pretty Wrap toggle switches between virtualized view and wrapped container
    await rabPage.getByRole('tab', { name: /^Pretty/ }).click();
    await rabPage.getByTestId('toggle-wrap').click();
    await expect(rabPage.getByTestId('pretty-wrapped')).toBeVisible();
    await rabPage.getByTestId('toggle-wrap').click();
    await expect(rabPage.getByTestId('pretty-wrapped')).toBeHidden();

    // Response download produces valid formatted JSON
    const [respDownload] = await Promise.all([
      rabPage.waitForEvent('download'),
      rabPage.getByTestId('download').click(),
    ]);
    const respPath = await respDownload.path();
    expect(respPath).toBeTruthy();
    const respJson = JSON.parse(await fs.readFile(respPath!, 'utf-8'));
    expect(respJson).toBeTruthy();

    // OperationHeader OpenAPI button downloads a valid OpenAPI 3.1 document
    const openApiBtn = rabPage.getByTestId('export-module-openapi');
    const [apiDownload] = await Promise.all([
      rabPage.waitForEvent('download'),
      openApiBtn.click(),
    ]);
    await expect(openApiBtn).toHaveAttribute('data-state', 'done');
    const apiPath = await apiDownload.path();
    expect(apiPath).toBeTruthy();
    const spec = JSON.parse(await fs.readFile(apiPath!, 'utf-8')) as { openapi?: string; paths?: Record<string, unknown> };
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths || {}).length).toBeGreaterThan(0);
  });

  test('generates DTO JSON example on Body tab without sending writes', async ({ rabPage, rabApi, product }) => {
    const catResp = await rabApi.get(product.url('/rest/restbrowser/1/catalog'));
    expect(catResp.ok()).toBe(true);
    const cat = (await catResp.json()) as { hash: string };

    const idxResp = await rabApi.get(product.url(`/rest/restbrowser/1/catalog/index/${encodeURIComponent(cat.hash)}`));
    expect(idxResp.ok()).toBe(true);
    const idx = (await idxResp.json()) as {
      operations: Array<{
        key: string;
        method: string;
        bodyType?: string;
        bodyJavaType?: string;
        params?: Array<{ in: string }>;
        consumes?: string[];
      }>;
    };

    const dtoOp = idx.operations.find((op) => {
      const bt = op.bodyJavaType || op.bodyType || '';
      return ['POST', 'PUT'].includes(op.method)
        && bt.length > 0
        && !['java.', 'javax.', 'jakarta.', 'byte['].some((p) => bt.startsWith(p))
        && !['String', 'Object', 'Map', 'InputStream'].includes(bt)
        && !(op.params || []).some((p) => p.in === 'form')
        && (!op.consumes || !op.consumes.length || op.consumes.some((c) => /json/i.test(c)));
    });

    test.skip(!dtoOp, 'No JSON DTO body operation found in this catalog');

    await rabPage.goto(product.url(`/plugins/servlet/rest-api-browser?op=${encodeURIComponent(dtoOp!.key)}`));
    await expect(rabPage.getByTestId('operation')).toBeVisible({ timeout: 45_000 });
    await rabPage.locator('.rab-n-request [role="tab"]', { hasText: 'Body' }).click();

    const genBtn = rabPage.getByTestId('generate-example');
    await expect(genBtn).toBeVisible();
    await genBtn.click();

    const bodyArea = rabPage.getByTestId('body');
    await expect(bodyArea).not.toHaveValue(/^\s*$/, { timeout: 20_000 });
    const rawBody = await bodyArea.inputValue();
    expect(() => JSON.parse(rawBody)).not.toThrow();
    await expect(rabPage.getByTestId('response')).toHaveCount(0);
  });

  test('supports /, Escape, and More actions menu keyboard behavior', async ({ rabPage, product }) => {
    await openNewUi(rabPage, product);

    await rabPage.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await rabPage.keyboard.press('/');
    const search = rabPage.getByTestId('search');
    await expect(search).toBeFocused();

    await search.fill(product.search);
    await expect(rabPage.getByTestId('status')).toContainText(/\bof\b/);
    await expect(rabPage.locator(`[data-testid="op"][data-method="GET"][data-path="${product.title}"]`)).toBeVisible();
    await rabPage.keyboard.press('ArrowDown');
    await rabPage.keyboard.press('Enter');
    await expect(rabPage.getByTestId('operation-path')).toBeVisible();

    await search.focus();
    await rabPage.keyboard.press('Escape');
    await expect(search).toHaveValue('');

    await rabPage.getByTestId('menu-button').click();
    const issueLink = rabPage.getByTestId('report-issue');
    await expect(issueLink).toBeVisible();
    await expect(issueLink).toHaveAttribute('target', '_blank');
    await expect(issueLink).toHaveAttribute('href', /github\.com\/.*\/issues\/new/);
    await rabPage.keyboard.press('Escape');
    await expect(rabPage.getByTestId('menu')).toHaveCount(0);
  });
});
