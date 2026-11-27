import { expect, openNewUi, openOperation, test } from './fixtures';

const ODD_VALUE = 'no such?#%&$&';
const ODD_ENCODED = 'no%20such%3F%23%25%26%24%26';

test.describe('Deep links, URL encoding, form parameters, and history', () => {
  test('prefills deep link without auto-sending and tolerates prototype keys', async ({ rabApi, rabPage, product }) => {
    const opsRes = await rabApi.get(product.url(`/rest/restbrowser/1/catalog/operations?q=${encodeURIComponent(product.search)}&method=GET&limit=30`));
    expect(opsRes.status()).toBe(200);
    const opsData = (await opsRes.json()) as { operations: Array<{ key: string; fullPath?: string; path?: string; method: string }> };
    const targetOp = opsData.operations.find((o) => (o.fullPath || o.path || '').endsWith(product.title));
    expect(targetOp, `Operation matching ${product.title} not found`).toBeTruthy();

    await rabPage.goto(
      product.url(`/plugins/servlet/rest-api-browser?op=${encodeURIComponent(targetOp!.key)}&toString=1&__proto__=polluted`),
    );
    await expect(rabPage.getByTestId('operation-path')).toHaveText(product.title, { timeout: 45_000 });
    await expect(rabPage.getByTestId('response')).toHaveCount(0);
  });

  test('enforces required path parameter, URL-encodes values, and records History', async ({ rabPage, product }) => {
    await openNewUi(rabPage, product);
    await openOperation(rabPage, product.templated, product.templated, 'GET');

    const sendBtn = rabPage.getByTestId('send');
    const copyCurlBtn = rabPage.getByTestId('copy-curl');
    await expect(rabPage.getByTestId('params-warn')).toBeVisible();
    await expect(sendBtn).toBeDisabled();
    await expect(copyCurlBtn).toBeDisabled();

    const pathInput = rabPage.locator(`[data-testid="params"] input[name="${product.param}"]`);
    await expect(pathInput).toBeVisible();
    await pathInput.fill(ODD_VALUE);

    await expect(rabPage.getByTestId('params-warn')).toHaveCount(0);
    await expect(sendBtn).toBeEnabled();
    await expect(copyCurlBtn).toBeEnabled();
    await expect(rabPage.getByTestId('live-url')).toContainText('/' + ODD_ENCODED);

    await sendBtn.click();
    await expect(rabPage.getByTestId('response-status')).toContainText(/^\d{3}\b/, { timeout: 25_000 });

    await rabPage.locator('.rab-n-request [role="tab"]', { hasText: 'History' }).click();
    const historyRows = rabPage.locator('[data-testid="history"] .rab-n-history-row');
    await expect(historyRows.first()).toBeVisible({ timeout: 10_000 });
    await expect(historyRows.first()).toContainText(ODD_ENCODED);

    await rabPage.getByRole('button', { name: 'Clear history' }).click();
    await expect(rabPage.getByTestId('history')).toHaveCount(0);
  });

  test('syncs form parameters to Body tab without sending writes', async ({ rabApi, rabPage, product }) => {
    const catResp = await rabApi.get(product.url('/rest/restbrowser/1/catalog'));
    expect(catResp.ok()).toBe(true);
    const cat = (await catResp.json()) as { hash: string };

    const idxResp = await rabApi.get(product.url(`/rest/restbrowser/1/catalog/index/${encodeURIComponent(cat.hash)}`));
    expect(idxResp.ok()).toBe(true);
    const idx = (await idxResp.json()) as {
      operations: Array<{
        key: string;
        method: string;
        params?: Array<{ name: string; in: string; type?: string; options?: string[] }>;
      }>;
    };

    let formParamName = '';
    const formOp = idx.operations.find((op) => {
      if (!['POST', 'PUT'].includes(op.method)) return false;
      const p = (op.params || []).find((param) =>
        param.in === 'form'
        && param.type !== 'File'
        && (param.type || '').toLowerCase() !== 'boolean'
        && !(param.options && param.options.length > 0),
      );
      if (!p) return false;
      formParamName = p.name;
      return true;
    });

    test.skip(!formOp, 'No text/scalar POST/PUT form-parameter operation found in this catalog');

    await rabPage.goto(product.url(`/plugins/servlet/rest-api-browser?op=${encodeURIComponent(formOp!.key)}`));
    await expect(rabPage.getByTestId('operation')).toBeVisible({ timeout: 45_000 });

    const formInput = rabPage.locator(`[data-testid="params"] input[name="${formParamName}"]`);
    await expect(formInput).toBeVisible();
    await expect(formInput).toBeEnabled();
    await formInput.fill('pw-form-preview');

    await rabPage.locator('.rab-n-request [role="tab"]', { hasText: 'Body' }).click();
    await expect(rabPage.getByTestId('form-body-note')).toBeVisible();
    await expect(rabPage.getByTestId('body')).toBeDisabled();
    await expect(rabPage.getByTestId('response')).toHaveCount(0);
  });
});
