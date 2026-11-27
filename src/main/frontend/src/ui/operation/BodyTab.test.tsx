// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDetails } from '../../core/details';
import { op } from '../../core/fixtures';
import type { RequestValues } from '../../core/request';
import { clearEscapeStack } from '../../lib/overlay';
import { BodyTab } from './BodyTab';

const waitUntil = async (fn: () => boolean, ms = 500) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !fn()) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return fn();
};

afterEach(() => {
  render(null, document.body);
  clearDetails();
  clearEscapeStack();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const emptyValues = (body = ''): RequestValues => ({
  path: {},
  query: {},
  form: {},
  header: {},
  matrix: {},
  body,
  contentType: 'application/json',
});

describe('ui/operation/BodyTab', () => {
  it('validates JSON body and formats valid JSON via onValues', async () => {
    const postOp = op('demo:mod', 'POST', 'items', {
      consumes: ['application/json'],
      bodyType: 'ItemDto',
    });
    const onValues = vi.fn();

    render(
      <div class="rab-n">
        <BodyTab
          baseUrl="/jira"
          sysadmin={false}
          op={postOp}
          values={emptyValues('{bad')}
          onValues={onValues}
          hasForm={false}
          formActive={false}
          onOpenParams={() => undefined}
        />
      </div>,
      document.body,
    );

    expect(document.querySelector('[data-testid=generate-example]')).toBeNull();
    expect(document.querySelector('[data-testid=json-check]')?.textContent).toContain('Not valid JSON');
    expect((document.querySelector('[data-testid=body]') as HTMLTextAreaElement).getAttribute('aria-invalid')).toBe('true');

    const formatBtn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Format') as HTMLButtonElement;
    expect(formatBtn.disabled).toBe(true);

    render(
      <div class="rab-n">
        <BodyTab
          baseUrl="/jira"
          sysadmin={false}
          op={postOp}
          values={emptyValues('{"b":2,"a":1}')}
          onValues={onValues}
          hasForm={false}
          formActive={false}
          onOpenParams={() => undefined}
        />
      </div>,
      document.body,
    );
    await waitUntil(() => document.querySelector('[data-testid=json-check]')?.textContent?.trim() === 'Valid JSON');
    expect(document.querySelector('[data-testid=json-check]')?.textContent?.trim()).toBe('Valid JSON');

    const enabledFormat = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Format') as HTMLButtonElement;
    expect(enabledFormat.disabled).toBe(false);
    enabledFormat.click();
    expect(onValues).toHaveBeenCalledWith(expect.objectContaining({ body: '{\n  "b": 2,\n  "a": 1\n}' }), true);
  });

  it('generates DTO example JSON via /code/schema and handles empty/error responses', async () => {
    const postOp = op('demo:mod', 'POST', 'items', {
      consumes: ['application/json'],
      bodyType: 'com.example.CreateItemRequest',
      bodyJavaType: 'com.example.CreateItemRequest',
    });
    const onValues = vi.fn();

    let resolveFetch!: (res: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { resolveFetch = res; })));

    render(
      <div class="rab-n">
        <BodyTab
          baseUrl="/jira"
          sysadmin
          op={postOp}
          values={emptyValues('')}
          onValues={onValues}
          hasForm={false}
          formActive={false}
          onOpenParams={() => undefined}
        />
      </div>,
      document.body,
    );

    const genBtn = document.querySelector('[data-testid=generate-example]') as HTMLButtonElement;
    expect(genBtn).not.toBeNull();
    // Let mount effects settle before triggering state changes (mount resets formatNote/generating)
    await new Promise((r) => setTimeout(r, 20));
    genBtn.click();

    await waitUntil(() => genBtn.disabled && genBtn.textContent?.trim() === 'Generating…');
    expect(genBtn.disabled).toBe(true);
    expect(genBtn.textContent?.trim()).toBe('Generating…');

    resolveFetch(new Response(JSON.stringify({
      format: 1,
      operationKey: postOp.key,
      requestBody: {
        javaType: 'com.example.CreateItemRequest',
        example: { name: 'demo', count: 3 },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await waitUntil(() => !genBtn.disabled && document.body.textContent!.includes('Generated example from CreateItemRequest'));
    expect(onValues).toHaveBeenCalledWith(
      expect.objectContaining({ body: '{\n  "name": "demo",\n  "count": 3\n}' }),
      true,
    );

    // Missing example shows fallback note
    clearDetails();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      format: 1,
      operationKey: postOp.key,
      requestBody: { javaType: 'com.example.CreateItemRequest' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    genBtn.click();
    await waitUntil(() => document.body.textContent!.includes('No example payload available for this endpoint'));

    // HTTP failure shows status error without throwing
    clearDetails();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'system-admin-only' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })));
    genBtn.click();
    await waitUntil(() => document.body.textContent!.includes('Only system administrators see the Java behind an operation.') && !genBtn.disabled);
    expect(document.querySelector('[role=status]')?.textContent).toBe('Only system administrators see the Java behind an operation.');
  });

  it('disables raw body controls when form parameters are active and links back to Params', () => {
    const postOp = op('demo:mod', 'POST', 'upload', {
      consumes: ['application/json'],
      bodyType: 'ItemDto',
    });
    const onOpenParams = vi.fn();

    render(
      <div class="rab-n">
        <BodyTab
          baseUrl="/jira"
          sysadmin
          op={postOp}
          values={emptyValues('{"a":1}')}
          onValues={vi.fn()}
          hasForm
          formActive
          onOpenParams={onOpenParams}
        />
      </div>,
      document.body,
    );

    expect(document.querySelector('[data-testid=form-body-note]')).not.toBeNull();
    expect((document.querySelector('[data-testid=body]') as HTMLTextAreaElement).disabled).toBe(true);
    expect((document.querySelector('[data-testid=generate-example]') as HTMLButtonElement).disabled).toBe(true);
    const formatBtn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Format') as HTMLButtonElement;
    expect(formatBtn.disabled).toBe(true);

    const editLink = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Edit form fields') as HTMLButtonElement;
    editLink.click();
    expect(onOpenParams).toHaveBeenCalledTimes(1);
  });
});
