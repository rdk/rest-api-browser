import fs from 'node:fs';
import { defineConfig } from '@playwright/test';

const PRODUCT_URLS: Record<string, string> = {
  jira: 'http://localhost:2992/jira',
  confluence: 'http://localhost:1992/confluence',
};

const BROWSER_CANDIDATES = [
  process.env.RAB_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/microsoft-edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((p): p is string => Boolean(p));

const productId = (process.env.RAB_PRODUCT || 'jira').toLowerCase();
const baseUrl = (process.env.RAB_URL || PRODUCT_URLS[productId] || PRODUCT_URLS.jira).replace(/\/+$/, '');
const headed = /^(1|true|yes)$/i.test(process.env.RAB_HEADED || '');
const extraArgs = (process.env.RAB_BROWSER_ARGS || '').split(/\s+/).filter(Boolean);
const executablePath = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  outputDir: 'test-results',
  use: {
    baseURL: baseUrl,
    viewport: { width: 1500, height: 1000 },
    ignoreHTTPSErrors: true,
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    headless: !headed,
    ...(executablePath ? {} : { channel: 'chrome' }),
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      ...(extraArgs.length ? { args: extraArgs } : {}),
    },
  },
});
