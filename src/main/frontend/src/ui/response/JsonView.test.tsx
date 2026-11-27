// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLines } from '../../lib/json-lines';
import { clearEscapeStack } from '../../lib/overlay';
import { JsonView, PRETTY_LINE } from './JsonView';

const waitUntil = async (fn: () => boolean, ms = 500) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return fn();
};

afterEach(() => {
  render(null, document.body);
  clearEscapeStack();
  document.body.innerHTML = '';
});

describe('ui/response/JsonView', () => {
  it('cuts lines past PRETTY_LINE, opens full value in readonly textarea modal, and supports Escape', async () => {
    const exact10k = 'a'.repeat(PRETTY_LINE);
    const over10k = 'b'.repeat(25_000);
    const model = buildLines(JSON.stringify({ exact: exact10k, big: over10k }))!;

    render(
      <div class="rab-n">
        <div class="rab-n-topbar" />
        <div class="rab-n-body-row">
          <JsonView model={model} needle="" step={{ n: 0, dir: 1 }} onFound={vi.fn()} />
        </div>
      </div>,
      document.body,
    );
    await new Promise((r) => setTimeout(r, 20));

    const buttons = [...document.querySelectorAll('[data-testid=view-full-line]')];
    // Only the >10,000-character line shows "View full"; the 10,000-character value line still includes quotes + key
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    const smallModel = buildLines(`{"short":"${'x'.repeat(PRETTY_LINE - 12)}"}`)!;
    expect(smallModel.lines[1].text.trimStart().length).toBeLessThanOrEqual(PRETTY_LINE);

    (buttons.at(-1) as HTMLButtonElement).click();
    await waitUntil(() => !!document.querySelector('[data-testid=full-value-textarea]')
      && !!document.querySelector('.rab-n-topbar')?.hasAttribute('inert'));

    const area = document.querySelector('[data-testid=full-value-textarea]') as HTMLTextAreaElement;
    expect(area).not.toBeNull();
    expect(area.readOnly).toBe(true);
    expect(area.value).toContain(over10k);
    expect(document.querySelector('.rab-n-topbar')?.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('[data-testid=full-value-dialog]')?.closest('[inert]')).toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await waitUntil(() => !document.querySelector('[data-testid=full-value-dialog]')
      && !document.querySelector('.rab-n-topbar')?.hasAttribute('inert'));
    expect(document.querySelector('[data-testid=full-value-dialog]')).toBeNull();
    expect(document.querySelector('.rab-n-topbar')?.hasAttribute('inert')).toBe(false);
  });

  it('handles a 1 MB value line and wrapped Pretty mode with search highlighting', async () => {
    const oneMb = 'z'.repeat(1_048_576);
    const model = buildLines(`{"huge":"${oneMb}","flag":true}`)!;

    render(
      <div class="rab-n">
        <div class="rab-n-topbar" />
        <div class="rab-n-body-row">
          <JsonView model={model} needle="flag" step={{ n: 1, dir: 1 }} onFound={vi.fn()} />
        </div>
      </div>,
      document.body,
    );
    await new Promise((r) => setTimeout(r, 20));

    const btn = document.querySelector('[data-testid=view-full-line]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    await new Promise((r) => setTimeout(r, 20));
    const area = document.querySelector('[data-testid=full-value-textarea]') as HTMLTextAreaElement;
    expect(area.value.length).toBeGreaterThan(1_048_576);
    (document.querySelector('[data-testid=full-value-close]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));

    // Wrapped mode renders outside VirtualList with .is-wrap
    render(
      <div class="rab-n">
        <JsonView model={buildLines('{"alpha":"hello","beta":{"nested":1}}')!} needle="nested" step={{ n: 1, dir: 1 }} onFound={vi.fn()} wrap />
      </div>,
      document.body,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector('[data-testid=pretty-wrapped]')?.classList.contains('is-wrap')).toBe(true);
    expect(document.querySelector('[data-testid=pretty-wrapped] .rab-n-line.current')).not.toBeNull();
  });
});
