import { expect, openNewUi, openOperation, test } from './fixtures';

test.describe('Skins, colour modes, fullscreen overlays, and sidebar controls', () => {
  test('switches skin and colour mode and persists skin across reload', async ({ rabPage, product }) => {
    await openNewUi(rabPage, product);

    const root = rabPage.locator('.rab-n');
    const html = rabPage.locator('html');

    await rabPage.getByTestId('menu-button').click();
    const menu = rabPage.getByTestId('menu');
    await expect(menu).toBeVisible();

    await rabPage.getByTestId('skin-vivid').click();
    await expect(menu).toBeVisible();
    await expect(root).toHaveAttribute('data-skin', 'vivid');

    await rabPage.getByTestId('mode-dark').click();
    await expect(html).toHaveAttribute('data-color-mode', 'dark');
    await expect(html).toHaveAttribute('data-theme', /dark:dark/);
    await expect(html).toHaveAttribute('data-theme', /light:light/);

    await rabPage.getByTestId('mode-light').click();
    await expect(html).toHaveAttribute('data-color-mode', 'light');

    // Skin preference survives page reload
    await rabPage.reload();
    await expect(rabPage.getByTestId('search')).toBeVisible({ timeout: 60_000 });
    await expect(rabPage.locator('.rab-n')).toHaveAttribute('data-skin', 'vivid');

    // Restore default balanced skin cleanly
    await rabPage.getByTestId('menu-button').click();
    await rabPage.getByTestId('skin-balanced').click();
    await expect(rabPage.locator('.rab-n')).toHaveAttribute('data-skin', 'balanced');
  });

  test('maximizes request and response panes with inert background and restores via Escape', async ({ rabPage, product }) => {
    await openNewUi(rabPage, product);
    await openOperation(rabPage, product.search, product.title, 'GET');

    const topBar = rabPage.locator('.rab-n-topbar');
    const sidebarSide = rabPage.locator('.rab-n-side');

    await rabPage.getByTestId('send').click();
    await expect(rabPage.getByTestId('response-status')).toContainText(/^200\b/, { timeout: 25_000 });

    await rabPage.getByTestId('max-top').click();
    await expect(topBar).toHaveAttribute('inert', '');
    await expect(sidebarSide).toHaveAttribute('inert', '');
    await rabPage.keyboard.press('Escape');
    await expect(topBar).not.toHaveAttribute('inert', '');

    await rabPage.getByTestId('max-bottom').click();
    await expect(topBar).toHaveAttribute('inert', '');
    await expect(sidebarSide).toHaveAttribute('inert', '');
    await rabPage.keyboard.press('Escape');
    await expect(topBar).not.toHaveAttribute('inert', '');
  });

  test('supports Supported only filter and fold/unfold all modules', async ({ rabPage, product }) => {
    await openNewUi(rabPage, product);

    const supportedBtn = rabPage.getByTestId('supported-only');
    await expect(supportedBtn).toHaveAttribute('aria-pressed', 'false');
    await supportedBtn.click();
    await expect(supportedBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(rabPage.getByTestId('status')).toContainText(/\bof\b/);

    await supportedBtn.click();
    await expect(supportedBtn).toHaveAttribute('aria-pressed', 'false');
    await expect(rabPage.getByTestId('status')).toContainText(/operations in/);

    const toggleModules = rabPage.getByTestId('toggle-modules');
    await expect(toggleModules).toHaveAttribute('data-state', 'expanded');
    await toggleModules.click();
    await expect(toggleModules).toHaveAttribute('data-state', 'collapsed');
    await toggleModules.click();
    await expect(toggleModules).toHaveAttribute('data-state', 'expanded');
  });
});
