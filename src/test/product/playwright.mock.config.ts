import fs from 'node:fs';
import { defineConfig } from '@playwright/test';

const HEADED = /^(1|true|yes)$/i.test(process.env.RAB_HEADED || '');

function findBrowserExecutable(): string | undefined {
  const envPath = process.env.RAB_BROWSER;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const candidates = process.platform === 'win32'
    ? [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/usr/bin/microsoft-edge',
        ];
  return candidates.find((p) => fs.existsSync(p));
}

const executablePath = findBrowserExecutable();

export default defineConfig({
  testDir: './e2e-mock',
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    headless: !HEADED,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      ...(executablePath ? { executablePath } : { channel: 'chrome' }),
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-component-update',
      ],
    },
  },
});
