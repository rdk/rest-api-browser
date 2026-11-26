import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { placeFloatingTip, readTipAttrs, splitShortcutKeys, type UiTipSpec } from '../core/uitips';
import { ESCAPE_PRIORITY, isInsideInert, onInertChange, useEscape } from '../lib/overlay';
import { usePin } from './bits';

interface ActiveTip {
  el: HTMLElement;
  spec: UiTipSpec;
  rect: DOMRect;
}

const HOVER_DELAY_MS = 320;
const HIDE_DELAY_MS = 70;

/**
 * Single delegated rich tooltip renderer for all buttons, links, tabs, and badges carrying `data-tip`.
 * Never disturbs flex/segmented layouts, yields to dedicated rich tooltips (`RichTip`, `About`, `ClassHoverCard`, `RowCard`),
 * hides immediately on click/scroll/blur/Escape, and supports `Alt+P` pinning consistently across the app.
 */
export function UiTipLayer({ rootRef }: { rootRef: { current: HTMLElement | null } }) {
  const [active, setActive] = useState<ActiveTip | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<ActiveTip | null>(null);
  activeRef.current = active;
  const pinnedRef = useRef(false);

  const [pinned] = usePin(
    () => !!activeRef.current && !isInsideInert(activeRef.current.el),
    boxRef,
    () => setActive(null),
    () => isInsideInert(activeRef.current?.el),
  );
  pinnedRef.current = pinned;

  useEscape(!!active && !pinned, () => {
    if (isInsideInert(activeRef.current?.el)) {
      setActive(null);
      return false;
    }
    setActive(null);
    return true;
  }, ESCAPE_PRIORITY.TOOLTIP);

  useEffect(() => {
    if (!active) return;
    const dismissIfInert = () => {
      if (activeRef.current && isInsideInert(activeRef.current.el)) {
        setActive(null);
      }
    };
    dismissIfInert();
    const offInert = onInertChange(dismissIfInert);
    const root = rootRef.current;
    const obs = typeof MutationObserver !== 'undefined'
      ? new MutationObserver(dismissIfInert)
      : null;
    if (obs && root) obs.observe(root, { attributes: true, subtree: true, attributeFilter: ['inert'] });
    return () => {
      offInert();
      obs?.disconnect();
    };
  }, [!!active, rootRef]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let showTimer: ReturnType<typeof setTimeout> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    let lastEl: HTMLElement | null = null;

    const findTarget = (node: EventTarget | null): HTMLElement | null => {
      if (!(node instanceof Element)) return null;
      if (node.closest('[data-class-ref], .rab-n-class-tip, .rab-n-tip-wrap, .rab-n-brand-wrap, [data-i]')) return null;
      const el = node.closest('[data-tip]') as HTMLElement | null;
      if (!el || !root.contains(el) || isInsideInert(el)) return null;
      if (el.hasAttribute('data-class-ref') || el.closest('[data-class-ref]')) return null;
      return el;
    };

    const show = (el: HTMLElement, delay: number) => {
      clearTimeout(hideTimer);
      clearTimeout(showTimer);
      if (pinnedRef.current) return;
      const spec = readTipAttrs(el);
      if (!spec) return;
      lastEl = el;
      const commit = () => {
        if (pinnedRef.current || !el.isConnected || isInsideInert(el)) return;
        if (root.querySelector('[data-testid=class-hover-card], .rab-n-tip-wrap.pinned, .rab-n-brand-wrap.pinned, #rab-n-row-card.pinned')) return;
        const fresh = readTipAttrs(el);
        if (!fresh) return;
        setActive({ el, spec: fresh, rect: el.getBoundingClientRect() });
      };
      if (delay <= 0) commit();
      else showTimer = setTimeout(commit, delay);
    };

    const hideSoon = () => {
      clearTimeout(showTimer);
      lastEl = null;
      if (pinnedRef.current) return;
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!pinnedRef.current) setActive(null);
      }, HIDE_DELAY_MS);
    };

    const hideNow = () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      lastEl = null;
      if (!pinnedRef.current) setActive(null);
    };

    const onOver = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('[data-class-ref], .rab-n-class-tip, .rab-n-tip-wrap, .rab-n-brand-wrap, [data-i]')) {
        hideNow();
        return;
      }
      const el = findTarget(target);
      if (!el) {
        if (!target?.closest('.rab-n-uitip')) hideSoon();
        return;
      }
      if (el === lastEl && activeRef.current?.el === el) {
        clearTimeout(hideTimer);
        return;
      }
      show(el, activeRef.current ? 0 : HOVER_DELAY_MS);
    };

    const onOut = (e: MouseEvent) => {
      const from = findTarget(e.target);
      if (!from) return;
      const to = findTarget(e.relatedTarget);
      if (to === from) return;
      if (e.relatedTarget instanceof Element && e.relatedTarget.closest('.rab-n-uitip')) return;
      if (!to) hideSoon();
    };

    const onFocusIn = (e: FocusEvent) => {
      if (activeRef.current && isInsideInert(activeRef.current.el)) {
        setActive(null);
      }
      const el = findTarget(e.target);
      if (!el) {
        hideNow();
        return;
      }
      if (el.matches(':focus-visible')) show(el, 220);
    };

    const onFocusOut = () => {
      hideSoon();
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('.rab-n-uitip')) return;
      hideNow();
    };

    const onScroll = () => {
      if (!pinnedRef.current) hideNow();
    };

    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseout', onOut);
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    root.addEventListener('pointerdown', onPointerDown, true);
    root.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', hideNow);
    return () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseout', onOut);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      root.removeEventListener('pointerdown', onPointerDown, true);
      root.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', hideNow);
    };
  }, [rootRef]);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!active || !box) {
      setPos(null);
      return;
    }
    // Reset any prior right-edge clamping before measuring intrinsic dimensions on instant target handoff.
    box.style.left = '-9999px';
    box.style.top = '-9999px';
    const r = active.el.isConnected ? active.el.getBoundingClientRect() : active.rect;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const b = box.getBoundingClientRect();
    const next = placeFloatingTip(r, { width: b.width, height: b.height }, { width: vw, height: vh });
    box.style.left = next.left + 'px';
    box.style.top = next.top + 'px';
    setPos(next);
  }, [active, pinned]);

  if (!active) return null;
  const { spec } = active;
  const keys = spec.shortcut ? splitShortcutKeys(spec.shortcut) : [];
  return (
    <div
      ref={boxRef}
      class={
        'rab-n-uitip'
        + (spec.tone ? ' tone-' + spec.tone : '')
        + (pos?.above ? ' above' : '')
        + (pinned ? ' pinned' : '')
      }
      role="tooltip"
      data-testid="ui-tip"
      style={pos ? { left: pos.left + 'px', top: pos.top + 'px' } : { left: '-9999px', top: '-9999px' }}
    >
      {(spec.title || keys.length > 0) && (
        <div class="rab-n-uitip-head">
          {spec.title && <span class="rab-n-uitip-title">{spec.title}</span>}
          {keys.length > 0 && (
            <span class="rab-n-uitip-keys">
              {keys.map((k, i) => (
                <span key={i}>
                  {i > 0 && <span class="rab-n-uitip-plus">+</span>}
                  <kbd>{k}</kbd>
                </span>
              ))}
            </span>
          )}
        </div>
      )}
      <div class="rab-n-uitip-body">{spec.body}</div>
      {spec.note && <div class="rab-n-uitip-note">{spec.note}</div>}
      {pinned && (
        <div class="rab-n-uitip-pin">
          Pinned · <kbd>Esc</kbd> or click outside closes it
        </div>
      )}
    </div>
  );
}
