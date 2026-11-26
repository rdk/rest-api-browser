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
});
