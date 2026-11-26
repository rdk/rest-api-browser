// @vitest-environment jsdom
import { h, render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireInert, clearEscapeStack, ESCAPE_PRIORITY, isInsideInert, pushEscape, SplitHandle, startPointerDrag } from './index';

afterEach(() => {
  render(null, document.body);
  clearEscapeStack();
  document.body.innerHTML = '';
});

describe('escapeStack', () => {
  it('invokes handlers LIFO and stops propagation once handled', () => {
    const order: string[] = [];
    const outerCapture = vi.fn(() => order.push('outer-doc'));
    document.addEventListener('keydown', outerCapture);

    const releaseBottom = pushEscape(() => {
      order.push('bottom');
      return true;
    });
    const releasePassThrough = pushEscape(() => {
      order.push('passthrough');
      return false;
    });
    const releaseTop = pushEscape(() => {
      order.push('top');
    });

    const e1 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(e1);
    expect(order).toEqual(['top']);
    expect(e1.defaultPrevented).toBe(true);
    expect(outerCapture).not.toHaveBeenCalled();

    releaseTop();
    order.length = 0;

    // Passthrough returns false so underlying bottom handler catches Escape
    const e2 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(e2);
    expect(order).toEqual(['passthrough', 'bottom']);
    expect(outerCapture).not.toHaveBeenCalled();

    releasePassThrough();
    releaseBottom();
    releaseBottom(); // idempotent double release

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(outerCapture).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', outerCapture);
  });

  it('orders by priority tiers, skips modified/composing Escape events, and safely handles snapshot mutations', () => {
    const calls: string[] = [];
    let relModal!: () => void;
    pushEscape(() => {
      calls.push('base');
    }, ESCAPE_PRIORITY.BASE);
    relModal = pushEscape(() => {
      calls.push('modal');
    }, ESCAPE_PRIORITY.MODAL);
    pushEscape(() => {
      calls.push('tooltip');
      relModal(); // unregister lower handler mid-dispatch
      return false;
    }, ESCAPE_PRIORITY.TOOLTIP);

    // Ignored when modifiers or IME composition are active
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', ctrlKey: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', altKey: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, cancelable: true }));
    expect(calls).toEqual([]);

    // Tooltip (40) runs before base/modal despite insertion order, returns false -> skips released modal -> hits base (10)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(calls).toEqual(['tooltip', 'base']);
  });
});

describe('acquireInert', () => {
  it('ref-counts overlapping locks and stays idempotent on double release', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    const child = document.createElement('button');
    a.appendChild(child);
    document.body.append(a, b);

    expect(isInsideInert(child)).toBe(false);
    const release1 = acquireInert([a, a, b, null]);
    const release2 = acquireInert([a]);
    expect(a.hasAttribute('inert')).toBe(true);
    expect(b.hasAttribute('inert')).toBe(true);
    expect(isInsideInert(child)).toBe(true);

    // Calling release2 twice must NOT decrement a's remaining lock from release1
    release2();
    release2();
    expect(a.hasAttribute('inert')).toBe(true);
    expect(isInsideInert(child)).toBe(true);

    release1();
    release1();
    expect(a.hasAttribute('inert')).toBe(false);
    expect(b.hasAttribute('inert')).toBe(false);
    expect(isInsideInert(child)).toBe(false);
  });

  it('preserves pre-existing host inert attributes on release', () => {
    const hostInert = document.createElement('div');
    hostInert.setAttribute('inert', '');
    document.body.appendChild(hostInert);
    const release = acquireInert([hostInert]);
    expect(hostInert.hasAttribute('inert')).toBe(true);
    release();
    expect(hostInert.hasAttribute('inert')).toBe(true);
  });
});

describe('startPointerDrag', () => {
  it('ends cleanly on blur, pointercancel, or explicit stop and ignores secondary clicks', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);

    const onMove = vi.fn();
    const onEnd = vi.fn();
    const secondary = { button: 2, clientX: 0, clientY: 0, pointerId: 1, currentTarget: el, preventDefault: vi.fn() } as unknown as PointerEvent;
    expect(startPointerDrag(secondary, { onMove, onEnd })).toBeNull();

    const down1 = { button: 0, clientX: 10, clientY: 20, pointerId: 1, currentTarget: el, preventDefault: vi.fn() } as unknown as PointerEvent;
    const stop1 = startPointerDrag(down1, { onMove, onEnd, raf: false });
    expect(stop1).not.toBeNull();
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 25, clientY: 30 }) as unknown as PointerEvent);
    expect(onMove).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('blur'));
    expect(onEnd).toHaveBeenCalledTimes(1);
    // Further moves do not fire after blur cleanup
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 40, clientY: 50 }) as unknown as PointerEvent);
    expect(onMove).toHaveBeenCalledTimes(1);

    onEnd.mockClear();
    const stop2 = startPointerDrag(down1, { onMove, onEnd, raf: false })!;
    stop2();
    stop2(); // idempotent
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('ignores foreign numeric pointerIds and drops pending rAF moves on abort stop()', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const origRaf = globalThis.requestAnimationFrame;
    const origCancel = globalThis.cancelAnimationFrame;
    let queued: FrameRequestCallback | null = null;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queued = cb;
      return 1;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = vi.fn();

    try {
      const onMove = vi.fn();
      const onEnd = vi.fn();
      const down = { button: 0, clientX: 0, clientY: 0, pointerId: 11, currentTarget: el, preventDefault: vi.fn() } as unknown as PointerEvent;
      const abort = startPointerDrag(down, { onMove, onEnd, raf: true })!;

      // Foreign pointer moves/ups must be ignored
      const foreignMove = Object.assign(new MouseEvent('pointermove', { clientX: 50, clientY: 50 }), { pointerId: 99 });
      window.dispatchEvent(foreignMove);
      expect(queued).toBeNull();

      const foreignUp = Object.assign(new MouseEvent('pointerup'), { pointerId: 99 });
      window.dispatchEvent(foreignUp);
      expect(onEnd).not.toHaveBeenCalled();

      // Queue matching move then abort -> must NOT flush pending rAF move into onMove
      const matchMove = Object.assign(new MouseEvent('pointermove', { clientX: 30, clientY: 30 }), { pointerId: 11 });
      window.dispatchEvent(matchMove);
      expect(queued).not.toBeNull();
      abort();
      expect(onMove).not.toHaveBeenCalled();
      expect(onEnd).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.requestAnimationFrame = origRaf;
      globalThis.cancelAnimationFrame = origCancel;
    }
  });
});

describe('SplitHandle', () => {
  it('supports WAI-ARIA separator attributes and keyboard stepping (Arrow, Shift+Arrow, Home, End)', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      h(SplitHandle, {
        className: 'test-split',
        orientation: 'vertical',
        label: 'Resize sidebar',
        value: 300,
        min: 200,
        max: 600,
        step: 20,
        bigStep: 80,
        onChange,
        onCommit,
        testId: 'split',
      }),
      document.body,
    );
    const sep = document.querySelector('[data-testid=split]') as HTMLElement;
    expect(sep.getAttribute('role')).toBe('separator');
    expect(sep.getAttribute('aria-valuenow')).toBe('300');

    sep.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(onCommit).toHaveBeenLastCalledWith(320);

    sep.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }));
    expect(onCommit).toHaveBeenLastCalledWith(220);

    sep.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(onCommit).toHaveBeenLastCalledWith(200);

    sep.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(onCommit).toHaveBeenLastCalledWith(600);
  });
});
