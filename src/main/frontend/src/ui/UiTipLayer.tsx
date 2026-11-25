import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { placeFloatingTip, readTipAttrs, splitShortcutKeys, type UiTipSpec } from '../core/uitips';
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
 * Lives as a fixed overlay above dialogs (`z-index: 98`), never disturbs flex/segmented layouts, suppresses
 * conflicts with `RichTip` / `About` / `ClassHoverCard` / `RowCard`, hides immediately on click/scroll/Escape,
 * and supports `Alt+P` pinning consistently with every other rich tooltip in the app.
 */
export function UiTipLayer({ rootRef }: { rootRef: { current: HTMLElement | null } }) {
  const [active, setActive] = useState<ActiveTip | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<ActiveTip | null>(null);
  activeRef.current = active;
  const pinnedRef = useRef(false);

  const [pinned] = usePin(
    () => !!activeRef.current,
    boxRef,
    () => setActive(null),
  );
  pinnedRef.current = pinned;

  // Escape dismisses an unpinned tooltip before any outer handler sees it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || pinnedRef.current || !activeRef.current) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setActive(null);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let showTimer: ReturnType<typeof setTimeout> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    let lastEl: HTMLElement | null = null;

    const findTarget = (node: EventTarget | null): HTMLElement | null => {
      if (!(node instanceof Element)) return null;
      // Yield to dedicated rich tooltips (ClassHoverCard, About, RichTip, sidebar RowCard)
      if (node.closest('[data-class-ref], .rab-n-tip-wrap, .rab-n-brand-wrap, [data-i]')) return null;
      const el = node.closest('[data-tip]') as HTMLElement | null;
      if (!el || !root.contains(el) || el.closest('[inert]')) return null;
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
        if (pinnedRef.current || !el.isConnected) return;
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
      const el = findTarget(e.target);
      if (!el) {
        if (activeRef.current && !(e.target instanceof Element && e.target.closest('.rab-n-uitip'))) {
          hideSoon();
        }
        return;
      }
      if (el === lastEl && activeRef.current?.el === el) {
        clearTimeout(hideTimer);
        return;
      }
      // Instant handoff when moving between adjacent toolbar buttons while a tooltip is already visible
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
      const el = findTarget(e.target);
      if (el && el.matches(':focus-visible')) show(el, 220);
    };

    const onFocusOut = () => {
      hideSoon();
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('.rab-n-uitip')) return;
      hideNow();
    };

    const onScroll = () => {
      if (activeRef.current && !pinnedRef.current) hideNow();
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
    if (!active || !boxRef.current) {
      setPos(null);
      return;
    }
    const r = active.el.isConnected ? active.el.getBoundingClientRect() : active.rect;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const b = boxRef.current.getBoundingClientRect();
    setPos(placeFloatingTip(r, { width: b.width, height: b.height }, { width: vw, height: vh }));
  }, [active]);

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
