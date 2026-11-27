import { expect, openNewUi, openOperation, test } from './fixtures';

test.describe('Java tab, tabbed decompiler, and code intelligence panels', () => {
  test('opens SourceDialog from Java tab, inspects Impls/Callers/Grep/Files, switches CFR, and preserves tabs on minimize', async ({ rabPage, product }) => {
    await openNewUi(rabPage, product);
    await openOperation(rabPage, product.search, product.title, 'GET');

    await rabPage.locator('.rab-n-request [role="tab"]', { hasText: 'Java' }).click();
    await expect(rabPage.getByTestId('java-signature')).toContainText(product.methodName, { timeout: 20_000 });
    await expect(rabPage.locator('[data-testid="java-signature"] .rab-n-jc-ann').first()).toBeVisible();

    await rabPage.getByTestId('load-class-source').click();
    const dlg = rabPage.getByTestId('source-dialog');
    await expect(dlg).toBeVisible({ timeout: 25_000 });

    const codeBox = dlg.getByTestId('dialog-source-code');
    await expect(codeBox).toBeVisible();
    await expect(codeBox.locator('[data-focus-line="true"]')).toContainText(product.methodName);

    // Impls panel
    await dlg.getByTestId('source-panel-implementations').click();
    await expect(dlg.getByTestId('implementations-panel')).toBeVisible();
    await expect(dlg.getByTestId('implementations-panel')).not.toContainText('Scanning OSGi bundles…', { timeout: 20_000 });

    // Callers panel
    await dlg.getByTestId('source-panel-callers').click();
    await expect(dlg.getByTestId('callers-panel')).toBeVisible();
    await expect(dlg.getByTestId('callers-panel')).not.toContainText('Searching callers…', { timeout: 20_000 });

    // Grep panel
    await dlg.getByTestId('source-panel-grep').click();
    await dlg.getByTestId('grep-query-input').fill('rest');
    await dlg.getByTestId('grep-submit').click();
    await expect(dlg.locator('[data-testid="grep-panel"] .rab-n-java-nav-count')).toBeVisible({ timeout: 20_000 });

    // Files panel -> open resource preview -> Escape closes preview without closing dialog
    await dlg.getByTestId('source-panel-resources').click();
    const firstFile = dlg.getByTestId('bundle-resource-item').first();
    await expect(firstFile).toBeVisible({ timeout: 20_000 });
    await firstFile.click();

    const preview = dlg.getByTestId('bundle-resource-preview');
    await expect(preview).toBeVisible();
    await expect(preview).not.toContainText(/^Loading /, { timeout: 15_000 });

    await rabPage.keyboard.press('Escape');
    await expect(preview).toHaveCount(0);
    await expect(codeBox).toBeVisible();

    await dlg.getByTestId('source-panel-outline').click();

    // Switch decompiler to CFR & open a 2nd tab via a referenced Java type
    await dlg.getByTestId('decompiler-cfr').click();
    await expect(dlg.getByTestId('dialog-decompiler')).toContainText(/CFR/, { timeout: 20_000 });

    const currentFqcn = (await dlg.getByTestId('dialog-class-name').textContent())?.trim() || '';
    const refLink = dlg.locator('[data-testid="dialog-source-code"] [data-class-ref]')
      .filter({ hasNotText: currentFqcn.split('.').pop() || '' })
      .first();
    await refLink.click();
    await expect(dlg.getByTestId('source-dialog-tab')).toHaveCount(2, { timeout: 20_000 });

    // Escape minimizes dialog while preserving tabs in topbar Classes badge
    await rabPage.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    await expect(rabPage.getByTestId('classes-tab-count')).toHaveText('2');
  });
});
