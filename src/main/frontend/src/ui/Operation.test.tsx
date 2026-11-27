// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { module, op, summary } from '../core/fixtures';
import { clearEscapeStack } from '../lib/overlay';
import { OperationView, type Draft } from './Operation';
import type { RequestRunner } from './runner';
import { UserStore } from './userstore';

afterEach(() => {
  render(null, document.body);
  clearEscapeStack();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setInput(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ui/OperationView', () => {
  it('validates parameters, switches sticky request tabs, checks JSON body, and supports undo/redo/reset', async () => {
    const mod = module('jira:api2', 'api/2');
    const getOp = op('jira:api2', 'GET', 'issue/{issueIdOrKey}', {
      params: [
        { name: 'issueIdOrKey', in: 'path', type: 'int', required: true },
        { name: 'expand', in: 'query', type: 'string', required: false },
      ],
    });
    const postOp = op('jira:api2', 'POST', 'issue', {
      consumes: ['application/json'],
    });
    const sm = summary([mod], { sysadmin: true });
    const runner = { running: false, abort: vi.fn(), run: vi.fn() } as unknown as RequestRunner;
    const userStore = new UserStore('test-op', null);
    const onDraft = vi.fn<(_k: string, _d: Draft) => void>();
    const onTab = vi.fn();

    // GET falls back from controlled tab='body' to 'params' and flags empty required params
    render(
      <div class="rab-n">
        <OperationView
          summary={sm}
          op={getOp}
          module={mod}
          onDraft={onDraft}
          runner={runner}
          userStore={userStore}
          split={0.45}
          onSplit={() => undefined}
          tab="body"
          onTab={onTab}
        />
      </div>,
      document.body,
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(document.querySelector('[data-testid=params]')).not.toBeNull();
    expect(document.querySelector('[data-testid=body]')).toBeNull();
    expect(document.querySelector('[data-testid=params-warn]')).not.toBeNull();
    expect((document.querySelector('[data-testid=send]') as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector('[data-testid=copy-curl]') as HTMLButtonElement).disabled).toBe(true);

    // Invalid int marks input aria-invalid="true"
    const pathInput = document.querySelector('input[name=issueIdOrKey]') as HTMLInputElement;
    setInput(pathInput, 'not-an-int');
    await new Promise((r) => setTimeout(r, 20));
    expect((document.querySelector('input[name=issueIdOrKey]') as HTMLInputElement).getAttribute('aria-invalid')).toBe('true');

    // Valid int clears warning and enables Send / Copy curl + Undo / Redo / Reset
    setInput(pathInput, '42');
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector('[data-testid=params-warn]')).toBeNull();
    expect(document.querySelector('[data-testid=live-url]')?.textContent).toContain('/rest/api/2/issue/42');
    expect((document.querySelector('[data-testid=send]') as HTMLButtonElement).disabled).toBe(false);
    expect((document.querySelector('[data-testid=copy-curl]') as HTMLButtonElement).disabled).toBe(false);

    // Separate step: edit query parameter, then reset, undo, redo
    setInput(document.querySelector('input[name=expand]') as HTMLInputElement, 'names');
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector('[data-testid=live-url]')?.textContent).toContain('expand=names');

    (document.querySelector('[data-testid=form-reset]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect((document.querySelector('input[name=issueIdOrKey]') as HTMLInputElement).value).toBe('');

    (document.querySelector('[data-testid=form-undo]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect((document.querySelector('input[name=issueIdOrKey]') as HTMLInputElement).value).toBe('42');

    (document.querySelector('[data-testid=form-redo]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect((document.querySelector('input[name=issueIdOrKey]') as HTMLInputElement).value).toBe('');

    // POST preserves controlled tab='body' and sets aria-invalid on malformed JSON
    render(
      <div class="rab-n">
        <OperationView
          key={postOp.key}
          summary={sm}
          op={postOp}
          module={mod}
          onDraft={onDraft}
          runner={runner}
          userStore={userStore}
          split={0.45}
          onSplit={() => undefined}
          tab="body"
          onTab={onTab}
        />
      </div>,
      document.body,
    );
    await new Promise((r) => setTimeout(r, 20));

    const bodyArea = document.querySelector('[data-testid=body]') as HTMLTextAreaElement;
    expect(bodyArea).not.toBeNull();
    setInput(bodyArea, '{bad json');
    await new Promise((r) => setTimeout(r, 20));
    expect((document.querySelector('[data-testid=body]') as HTMLTextAreaElement).getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('[data-testid=json-check]')?.classList.contains('is-warn')).toBe(true);
  });

  it('renders normal, required, hyphenated, long, and enum parameter rows in the params grid', async () => {
    const mod = module('example:rest', 'example/1.0');
    const complexOp = op('example:rest', 'GET', 'items/{id}', {
      params: [
        { name: 'id', in: 'path', type: 'string', required: true },
        { name: 'fromDate', in: 'query', type: 'string', required: false },
        { name: 'X-Custom-Token', in: 'header', type: 'string', required: false },
        { name: 'deleteOrganizationsWithInactiveUsers', in: 'query', type: 'boolean', required: false },
        { name: 'mode', in: 'query', type: 'CheckMode', required: true, options: ['FAST', 'THOROUGH', 'VERIFICATION_MODE_WITH_LONG_NAME'] },
      ],
    });
    const sm = summary([mod], { sysadmin: true });
    const runner = { running: false, abort: vi.fn(), run: vi.fn() } as unknown as RequestRunner;
    const userStore = new UserStore('test-op-grid', null);

    render(
      <div class="rab-n">
        <OperationView
          summary={sm}
          op={complexOp}
          module={mod}
          onDraft={() => undefined}
          runner={runner}
          userStore={userStore}
          split={0.45}
          onSplit={() => undefined}
        />
      </div>,
      document.body,
    );
    await new Promise((r) => setTimeout(r, 20));

    const grid = document.querySelector('[data-testid=params]') as HTMLElement;
    expect(grid).not.toBeNull();
    expect(grid.tagName).toBe('DIV');

    const rows = [...grid.querySelectorAll('.rab-n-param')];
    expect(rows).toHaveLength(5);
    const names = rows.map((r) => r.querySelector('.rab-n-param-name')?.textContent?.trim());
    expect(names).toEqual(['id*', 'mode*', 'fromDate', 'deleteOrganizationsWithInactiveUsers', 'X-Custom-Token']);
    expect(rows.every((r) => r.querySelector('.rab-n-param-value') && r.querySelector('.rab-n-param-meta'))).toBe(true);
    expect(rows[0].querySelector('.rab-n-param-name .rab-n-required')?.textContent).toBe('*');
    expect(rows[1].querySelector('select[name=mode]')?.querySelectorAll('option')).toHaveLength(4);
    expect(rows[3].querySelector('select[name=deleteOrganizationsWithInactiveUsers]')?.querySelectorAll('option')).toHaveLength(3);
  });

  it('exports module OpenAPI specification and generates DTO JSON body example', async () => {
    const mod = module('jira:api2', 'api/2');
    const postOp = op('jira:api2', 'POST', 'issue', {
      consumes: ['application/json'],
      bodyType: 'com.example.IssueCreateInput',
    });
    const sm = summary([mod], { sysadmin: true });
    const runner = { running: false, abort: vi.fn(), run: vi.fn() } as unknown as RequestRunner;
    const userStore = new UserStore('test-op-agent', null);
    const onDraft = vi.fn<(_k: string, _d: Draft) => void>();

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rest/restbrowser/1/catalog/openapi')) {
        return new Response(JSON.stringify({ openapi: '3.1.0', info: { title: 'api2', version: '1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/rest/restbrowser/1/code/schema')) {
        return new Response(JSON.stringify({
          format: 1,
          key: postOp.key,
          requestBody: {
            javaType: 'com.example.IssueCreateInput',
            example: { summary: 'Example issue', priority: 1 },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    const createMock = vi.fn(() => 'blob:openapi-test');
    const revokeMock = vi.fn();
    URL.createObjectURL = createMock;
    URL.revokeObjectURL = revokeMock;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    try {
      render(
        <div class="rab-n">
          <OperationView
            summary={sm}
            op={postOp}
            module={mod}
            onDraft={onDraft}
            runner={runner}
            userStore={userStore}
            split={0.45}
            onSplit={() => undefined}
            tab="body"
          />
        </div>,
        document.body,
      );
      const waitUntil = async (fn: () => boolean, ms = 500) => {
        const end = Date.now() + ms;
        while (Date.now() < end && !fn()) await new Promise((r) => setTimeout(r, 15));
        return fn();
      };
      await waitUntil(() => !!document.querySelector('[data-testid=export-module-openapi]'));

      const exportBtn = document.querySelector('[data-testid=export-module-openapi]') as HTMLButtonElement;
      expect(exportBtn).not.toBeNull();
      exportBtn.click();
      await waitUntil(() => exportBtn.getAttribute('data-state') === 'done');
      expect(fetchMock).toHaveBeenCalledWith(
        '/jira/rest/restbrowser/1/catalog/openapi?module=jira%3Aapi2',
        expect.anything(),
      );
      expect(createMock).toHaveBeenCalledTimes(1);
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(exportBtn.getAttribute('data-state')).toBe('done');

      const genBtn = document.querySelector('[data-testid=generate-example]') as HTMLButtonElement;
      expect(genBtn).not.toBeNull();
      genBtn.click();
      await waitUntil(() => document.body.textContent?.includes('Generated example from IssueCreateInput') ?? false);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/jira/rest/restbrowser/1/code/schema?'),
        expect.anything(),
      );
      const bodyArea = document.querySelector('[data-testid=body]') as HTMLTextAreaElement;
      expect(bodyArea.value).toBe('{\n  "summary": "Example issue",\n  "priority": 1\n}');
      expect(document.body.textContent).toContain('Generated example from IssueCreateInput');
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });
});
