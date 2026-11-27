import { expect, test } from './fixtures';

test.describe('Admin Intro landing page and Classic WADL UI', () => {
  test('renders decorated Admin Intro page with launch CTA, MCP config, and debugging prompt', async ({ rabPage, product }) => {
    await rabPage.goto(product.url('/plugins/servlet/rest-api-browser/admin'));
    const intro = rabPage.locator('#rab-admin-intro');
    await expect(intro).toBeVisible({ timeout: 30_000 });

    const cta = rabPage.locator('#rab-open-fullscreen');
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute('target', '_blank');
    await expect(cta).toHaveAttribute('href', /\/plugins\/servlet\/rest-api-browser$/);

    await expect(rabPage.locator('#rab-mcp-config')).toContainText('/rest/restbrowser/1/mcp');
    await expect(rabPage.locator('#rab-prompt-stuck')).toContainText('investigate_operation_context');

    const hasChrome = await rabPage.evaluate(() =>
      !!document.querySelector('#header, #admin-nav, #admin-menu, .aui-header, .aui-page-panel-nav, .acs-side-bar'),
    );
    expect(hasChrome).toBe(true);
  });

  test('renders decorated Classic WADL UI with public APIs or Confluence 10 fallback links', async ({ rabPage, product }) => {
    await rabPage.goto(product.url('/plugins/servlet/restbrowser'));
    await expect(rabPage.locator('#searchField')).toBeVisible({ timeout: 30_000 });
    await expect(rabPage.locator('#publicOnlyFilter')).toBeChecked();

    const hasAngular = await rabPage.evaluate(() => Boolean((window as unknown as { angular?: unknown }).angular));
    expect(hasAngular).toBe(true);

    // Wait for initial public WADL loading to complete (Angular renders the footer marker once all WADLs settle)
    await expect(rabPage.locator('#rab i', { hasText: /all the APIs/ })).toBeVisible({ timeout: 90_000 });

    const publicItems = rabPage.locator('#searchTextResults li a');
    const fallbackBox = rabPage.locator('#rab-wadl-fallback');

    const count = await publicItems.count();
    if (count > 0) {
      await expect(publicItems.first()).toBeVisible();
      const names = await publicItems.allTextContents();
      expect(names.some((n) => product.coreRe.test(n.trim()))).toBe(true);
    } else {
      await expect(fallbackBox).toBeVisible({ timeout: 30_000 });
      await expect(fallbackBox.locator('a.rab-wadl-fallback-cta')).toContainText('Open in the new UI');
      const items = await fallbackBox.locator('.rab-wadl-fallback-list li a').allTextContents();
      expect(items.some((t) => t.trim() === product.coreName || product.coreRe.test(`${t.trim()}/`))).toBe(true);
    }
  });
});
