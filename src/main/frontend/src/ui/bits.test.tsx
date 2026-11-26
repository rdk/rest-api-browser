// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearEscapeStack } from '../lib/overlay';
import { CheckMark, CopyButton, MaximizeButton, MethodBadge, PathText, RichTip, Tabs } from './bits';

afterEach(() => {
  render(null, document.body);
  clearEscapeStack();
  document.body.innerHTML = '';
});

describe('ui/bits components', () => {
  it('renders MethodBadge, PathText, CheckMark with rich tip attributes, and MaximizeButton', () => {
    const onToggle = vi.fn();
    render(
      <div>
        <MethodBadge method="DELETE" showTip />
        <PathText path="api/2/issue/{id}" prefix={5} words={['issue']} />
        <CheckMark check={{ state: 'warn', message: 'Required value' }} />
        <MaximizeButton on={false} onToggle={onToggle} what="request" testId="max-req" />
      </div>,
      document.body,
    );
    expect(document.querySelector('.rab-n-method-delete')?.textContent).toContain('DEL');
    expect(document.querySelector('.rab-n-pp-hit')?.textContent).toBe('issue');
    const check = document.querySelector('[data-testid=check]') as HTMLElement;
    expect(check.dataset.state).toBe('warn');
    expect(check.getAttribute('data-tip')).toBe('Required value');

    const maxBtn = document.querySelector('[data-testid=max-req]') as HTMLButtonElement;
    maxBtn.click();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('supports WAI-ARIA tablist ArrowLeft/ArrowRight/Home/End keyboard navigation in Tabs', () => {
    const onChange = vi.fn();
    render(
      <Tabs
        value="params"
        onChange={onChange}
        label="Request tabs"
        panelId="req-pane"
        tabs={[
          { id: 'params', label: 'Params' },
          { id: 'headers', label: 'Headers' },
          { id: 'java', label: 'Java' },
        ]}
      />,
      document.body,
    );
    const list = document.querySelector('[role=tablist]') as HTMLElement;
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(onChange).toHaveBeenLastCalledWith('headers');
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(onChange).toHaveBeenLastCalledWith('java');
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(onChange).toHaveBeenLastCalledWith('params');
  });

  it('pins and unpins RichTip on click and releases prior pinned tooltip when another pins', async () => {
    render(
      <div class="rab-n">
        <RichTip testId="tip-1" tip={<span>First tooltip</span>}>
          <span class="t1">First badge</span>
        </RichTip>
        <RichTip testId="tip-2" tip={<span>Second tooltip</span>}>
          <span class="t2">Second badge</span>
        </RichTip>
      </div>,
      document.body,
    );
    const wraps = document.querySelectorAll('.rab-n-tip-wrap');
    const targets = document.querySelectorAll<HTMLElement>('.rab-n-tip-target');
    expect(targets[0].getAttribute('role')).toBe('button');
    expect(targets[0].getAttribute('aria-pressed')).toBe('false');

    targets[0].click();
    await new Promise((r) => setTimeout(r, 20));
    expect(wraps[0].classList.contains('pinned')).toBe(true);
    expect(targets[0].getAttribute('aria-pressed')).toBe('true');

    // Pinning a second tooltip automatically unpins the first
    targets[1].click();
    await new Promise((r) => setTimeout(r, 20));
    expect(wraps[0].classList.contains('pinned')).toBe(false);
    expect(wraps[1].classList.contains('pinned')).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(wraps[1].classList.contains('pinned')).toBe(false);
  });

  it('flashes CopyButton state after copying text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton label="Copy URL" testId="copy-btn" text={() => 'https://example.test'} />, document.body);
    const btn = document.querySelector('[data-testid=copy-btn]') as HTMLButtonElement;
    btn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(writeText).toHaveBeenCalledWith('https://example.test');
    expect(btn.dataset.state).toBe('done');
  });
});
