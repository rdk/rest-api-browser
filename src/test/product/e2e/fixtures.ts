import { expect, request as playwrightRequest, test as base, type APIRequestContext, type Page } from '@playwright/test';

export type ProductId = 'jira' | 'confluence';

export interface ProductProfile {
  id: ProductId;
  name: string;
  baseUrl: string;
  contextPath: string;
  search: string;
  title: string;
  coreName: string;
  coreRe: RegExp;
  answerRe: RegExp;
  methodName: string;
  url: (path: string) => string;
}

const DEFAULTS: Record<ProductId, string> = {
  jira: 'http://localhost:2992/jira',
  confluence: 'http://localhost:1992/confluence',
};

export function getProductConfig(): {
  product: ProductProfile;
  user: string;
  password: string;
  authHeader: string;
} {
  const rawProd = (process.env.RAB_PRODUCT || 'jira').toLowerCase();
  if (rawProd !== 'jira' && rawProd !== 'confluence') {
    throw new Error(`Unsupported RAB_PRODUCT=${rawProd}; expected jira or confluence`);
  }
  const baseUrl = (process.env.RAB_URL || DEFAULTS[rawProd]).replace(/\/+$/, '');
  const contextPath = new URL(baseUrl).pathname.replace(/\/+$/, '');
  const user = process.env.RAB_USER || 'admin';
  const password = process.env.RAB_PASSWORD || 'admin';
  const authHeader = 'Basic ' + Buffer.from(`${user}:${password}`, 'utf-8').toString('base64');
  const url = (p: string) => `${baseUrl}${p.startsWith('/') ? p : `/${p}`}`;

  const profile: ProductProfile = rawProd === 'jira'
    ? {
      id: 'jira',
      name: 'Jira',
      baseUrl,
      contextPath,
      search: 'serverInfo',
      title: 'api/2/serverInfo',
      coreName: 'api/2',
      coreRe: /^api\/2\//,
      answerRe: /"baseUrl"|"version"/,
      methodName: 'getServerInfo',
      url,
    }
    : {
      id: 'confluence',
      name: 'Confluence',
      baseUrl,
      contextPath,
      search: 'user current',
      title: 'api/user/current',
      coreName: 'api',
      coreRe: /^api\//,
      answerRe: /"username"|"userKey"/,
      methodName: 'getCurrent',
      url,
    };

  return { product: profile, user, password, authHeader };
}

export async function openNewUi(page: Page, product: ProductProfile): Promise<void> {
  await page.goto(product.url('/plugins/servlet/rest-api-browser'));
  await expect(page.getByTestId('search')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('status')).toContainText(/operations/, { timeout: 90_000 });
}

export async function openOperation(
  page: Page,
  search: string,
  opPath: string,
  method = 'GET',
): Promise<void> {
  const searchBox = page.getByTestId('search');
  await searchBox.fill(search);
  const row = page.locator(`[data-testid="op"][data-method="${method}"][data-path="${opPath}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(page.getByTestId('operation-path')).toHaveText(opPath, { timeout: 15_000 });
}

interface RabFixtures {
  product: ProductProfile;
  rabApi: APIRequestContext;
  rabPage: Page;
}

export const test = base.extend<RabFixtures>({
  product: async ({}, use) => {
    await use(getProductConfig().product);
  },

  rabApi: async ({}, use) => {
    const cfg = getProductConfig();
    const ctx = await playwrightRequest.newContext({
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        Authorization: cfg.authHeader,
      },
    });
    try {
      await use(ctx);
    } finally {
      await ctx.dispose();
    }
  },

  rabPage: async ({ context, page }, use) => {
    const cfg = getProductConfig();
    const targetOrigin = new URL(cfg.product.baseUrl).origin;
    const exceptions: string[] = [];
    const failedRequests: string[] = [];

    // Attach Basic auth only to same-origin document/XHR/Fetch calls; adding it to static
    // web resources can make product decorators drop the session mid-load.
    await context.route('**/*', async (route) => {
      const req = route.request();
      const url = req.url();
      if (url.startsWith(targetOrigin) && ['document', 'xhr', 'fetch'].includes(req.resourceType())) {
        const headers = { ...req.headers(), authorization: cfg.authHeader };
        await route.continue({ headers });
      } else {
        await route.continue();
      }
    });

    page.on('pageerror', (err) => {
      const text = `${err.message || err}\n${err.stack || ''}`;
      const isThirdParty = /_super\/batch\.js/.test(text) || /\$\(\.\.\.\)\.live is not a function/.test(text);
      if (!isThirdParty && (!page.url().includes('/restbrowser') || /rest-api-browser|restbrowser|next\.js/i.test(text))) {
        exceptions.push(text.split('\n')[0]);
      }
    });

    page.on('response', (res) => {
      if (res.status() < 400) return;
      const url = res.url();
      if (!/restbrowser|rest-api-browser/i.test(url)) return;
      if (/op=no\.such(%3A|:)module/i.test(url) || /rest-api-browser-start/.test(url)) return;
      if (res.status() === 409 && /\/catalog\/started/.test(url)) return;
      failedRequests.push(`${res.status()} ${url}`);
    });

    await use(page);

    expect(exceptions, 'uncaught plugin JS exceptions').toEqual([]);
    expect(failedRequests, 'unexpected plugin HTTP >= 400 responses').toEqual([]);
  },
});

export { expect };
