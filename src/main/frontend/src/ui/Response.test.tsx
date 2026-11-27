// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../core/responsetext';
import { formatJson } from '../lib/json-lines';
import { clearEscapeStack } from '../lib/overlay';
import { ResponseView } from './Response';

const waitUntil = async (fn: () => boolean, ms = 600) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !fn()) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return fn();
};

const origClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
  render(null, document.body);
  clearEscapeStack();
  document.body.innerHTML = '';
  if (origClipboard) Object.defineProperty(navigator, 'clipboard', origClipboard);
  else delete (navigator as unknown as Record<string, unknown>).clipboard;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const jsonResult = (overrides: Partial<RunResult> = {}): RunResult => {
  const text = '{"alpha":"hit-one","beta":"hit-two"}';
  return {
    method: 'GET',
    url: '/jira/rest/api/2/serverInfo',
    status: 200,
    statusText: 'OK',
    ok: true,
    durationMs: 42,
    size: text.length,
    truncated: false,
    kind: 'json',
    contentType: 'application/json',
    headers: [
      ['content-type', 'application/json'],
      ['x-node-id', 'node-a'],
    ],
    requestHeaders: [['Accept', 'application/json']],
    requestBodyBytes: 0,
    sessionExpired: false,
    text,
    ...overrides,
  };
};

describe('ui/ResponseView', () => {
  it('renders idle, running with cancel, error states, and session-expired banner', () => {
    const onCancel = vi.fn();

    render(
      <div class="rab-n">
        <ResponseView result={null} running={false} onCancel={onCancel} maximized={false} onMaximize={vi.fn()} baseUrl="/jira" />
      </div>,
      document.body,
    );
    expect(document.querySelector('[data-testid=response-idle]')).not.toBeNull();

    render(
      <div class="rab-n">
        <ResponseView result={null} running onCancel={onCancel} maximized={false} onMaximize={vi.fn()} baseUrl="/jira" />
      </div>,
      document.body,
    );
    expect(document.querySelector('[data-testid=response-running]')).not.toBeNull();
    (document.querySelector('[data-testid=response-running] button') as HTMLButtonElement).click();
    expect(onCancel).toHaveBeenCalledTimes(1);

    render(
      <div class="rab-n">
        <ResponseView
          result={jsonResult({ error: 'aborted', ok: false, status: 0 })}
          running={false}
          onCancel={onCancel}
          maximized={false}
          onMaximize={vi.fn()}
          baseUrl="/jira"
        />
      </div>,
      document.body,
    );
    expect(document.querySelector('[data-testid=response-error]')?.textContent).toContain('The request was cancelled.');

    render(
      <div class="rab-n">
        <ResponseView
          result={jsonResult({ status: 401, statusText: 'Unauthorized', ok: false, sessionExpired: true })}
          running={false}
          onCancel={onCancel}
          maximized={false}
          onMaximize={vi.fn()}
          baseUrl="/jira"
        />
      </div>,
      document.body,
    );
    expect(document.querySelector('[data-testid=session-expired]')).not.toBeNull();
  });

  it('toggles Pretty Wrap, cycles FindBox/useFind matches, switches tabs, and copies formatted text', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      method: 'GET',
      headers: [
        ['Accept', 'application/json'],
        ['X-Forwarded-Host', 'proxy.example'],
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const res = jsonResult();
    render(
      <div class="rab-n">
        <ResponseView result={res} running={false} onCancel={vi.fn()} maximized={false} onMaximize={vi.fn()} baseUrl="/jira" />
      </div>,
      document.body,
    );

    expect(document.querySelector('[data-testid=response-status]')?.textContent?.trim()).toBe('200 OK');

    // Toggle Pretty Wrap on and off
    const wrapBtn = document.querySelector('[data-testid=toggle-wrap]') as HTMLButtonElement;
    wrapBtn.click();
    await waitUntil(() => !!document.querySelector('[data-testid=pretty-wrapped]'));
    expect(wrapBtn.getAttribute('aria-pressed')).toBe('true');

    wrapBtn.click();
    await waitUntil(() => !document.querySelector('[data-testid=pretty-wrapped]'));
    expect(wrapBtn.getAttribute('aria-pressed')).toBe('false');

    // FindBox: wait for input state commit before flushing pending search with Enter
    const findInput = document.querySelector('input[type=search]') as HTMLInputElement;
    findInput.value = 'hit';
    findInput.dispatchEvent(new Event('input', { bubbles: true }));
    await waitUntil(() => !!document.querySelector('[data-testid=find-count]'));
    findInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await waitUntil(() => document.querySelector('[data-testid=find-count]')?.textContent === '1 of 2 lines');
    expect(document.querySelector('[data-testid=find-count]')?.textContent).toBe('1 of 2 lines');

    findInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await waitUntil(() => document.querySelector('[data-testid=find-count]')?.textContent === '2 of 2 lines');
    expect(document.querySelector('[data-testid=find-count]')?.textContent).toBe('2 of 2 lines');

    findInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    await waitUntil(() => document.querySelector('[data-testid=find-count]')?.textContent === '1 of 2 lines');
    expect(document.querySelector('[data-testid=find-count]')?.textContent).toBe('1 of 2 lines');

    findInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await waitUntil(() => findInput.value === '' && !document.querySelector('[data-testid=find-count]'));

    // Copy Pretty content uses textOf format (with trailing newline)
    const copyBtn = document.querySelector('[data-testid=copy-content]') as HTMLButtonElement;
    copyBtn.click();
    await waitUntil(() => writeText.mock.calls.length === 1 && copyBtn.getAttribute('data-state') === 'done');
    expect(writeText).toHaveBeenCalledWith(formatJson(res.text!) + '\n');

    // Tabs: Raw, Response headers, Request headers
    const tabNamed = (prefix: string) =>
      [...document.querySelectorAll('.rab-n-tabbar-response [role=tab]')].find((t) => t.textContent?.startsWith(prefix)) as HTMLButtonElement;

    tabNamed('Raw').click();
    await waitUntil(() => document.querySelector('#rab-n-response-pane')?.textContent?.includes(res.text!) ?? false);
    expect(document.querySelector('#rab-n-response-pane')?.textContent).toContain(res.text!);

    tabNamed('Response headers').click();
    await waitUntil(() => !!document.querySelector('[data-testid=response-headers]'));
    expect(document.querySelector('[data-testid=response-headers]')?.textContent).toContain('node-a');

    tabNamed('Request headers').click();
    await waitUntil(() => document.querySelector('[data-testid=browser-header]')?.textContent?.includes('proxy.example') ?? false);
    expect(document.querySelector('[data-testid=request-header]')?.textContent).toContain('Accept: application/json');
    expect(document.querySelector('[data-testid=browser-header]')?.textContent).toContain('X-Forwarded-Host: proxy.example');
  });
});
