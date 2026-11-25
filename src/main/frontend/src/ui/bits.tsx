import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { pathParts } from '../core/pathparts';
import type { Check } from '../core/validate';

export const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function MethodBadge({ method }: { method: string }) {
  const m = method.toUpperCase();
  const cls = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m) ? m.toLowerCase() : 'other';
  return m === 'DELETE'
    ? <span class={'rab-n-method rab-n-method-' + cls} title="DELETE"><span aria-hidden="true">DEL</span><span class="rab-n-sr">DELETE</span></span>
    : <span class={'rab-n-method rab-n-method-' + cls}>{m}</span>;
}

/**
 * A path with its parts told apart: the first resource word bold, the second bold in its own color, separators,
 * versions and the module prefix fainter, {templates} in the path parameters' color, the search's words marked.
 */
export function PathText({ path, prefix, words, rank }: { path: string; prefix?: number; words?: string[]; rank?: boolean }) {
  return (
    <>
      {pathParts(path, { prefix, words, rank }).map((p, i) =>
        p.kind === 'text' && !p.hit ? p.text : <span key={i} class={'rab-n-pp-' + p.kind + (p.hit ? ' rab-n-pp-hit' : '')}>{p.text}</span>,
      )}
    </>
  );
}

/** The button that makes a box take the whole screen, and gives it back its place (Escape does too). */
export function MaximizeButton({ on, onToggle, what, testId }: { on: boolean; onToggle: () => void; what: string; testId: string }) {
  const label = on ? `Restore the ${what} (Esc)` : `Show the ${what} on the whole screen`;
  return (
    <button class={'rab-n-tool' + (on ? ' on' : '')} onClick={onToggle} title={label} aria-label={label} aria-pressed={on}
            data-testid={testId} data-state={on ? 'max' : 'normal'}>
      <svg class="rab-n-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d={on ? 'M6 2.5v3.5H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5' : 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10'}
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/** The key that pins a rich tooltip: Alt+P (by key position, so Option+P on a Mac works too). */
export const isPinKey = (e: KeyboardEvent) => e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyP';

/**
 * Ref-counted `inert` guard for stacked overlays (e.g. maximized request pane + floating Classes window) so closing
 * the inner overlay never strips `inert` while an outer overlay still covers the same elements.
 */
const inertCounts = new WeakMap<HTMLElement, number>();
export function acquireInert(elements: HTMLElement[]): () => void {
  for (const el of elements) {
    const n = (inertCounts.get(el) ?? 0) + 1;
    inertCounts.set(el, n);
    if (n === 1) el.setAttribute('inert', '');
  }
  return () => {
    for (const el of elements) {
      const n = Math.max(0, (inertCounts.get(el) ?? 1) - 1);
      if (n === 0) {
        inertCounts.delete(el);
        el.removeAttribute('inert');
      } else {
        inertCounts.set(el, n);
      }
    }
  };
}

/**
 * Pinning of a rich tooltip (the list's hover card, the header's about): Alt+P while it shows pins it, so it stays
 * and takes the pointer (its text can be selected, its links clicked); a click outside `box`, Escape or Alt+P again
 * lets it go, and `onRelease` hides it.
 */
export function usePin(shown: () => boolean, box: { current: HTMLElement | null }, onRelease?: () => void): [boolean, (next: boolean) => void] {
  const [pinned, setPinned] = useState(false);
  const latest = useRef({ shown, onRelease });
  latest.current = { shown, onRelease };
  useEffect(() => {
    const release = () => {
      setPinned(false);
      latest.current.onRelease?.();
    };
    const onKey = (e: KeyboardEvent) => {
      if (box.current?.closest('[inert]')) {
        if (pinned) release(); // hidden behind a box on the whole screen: let go, and leave the key to that box
        return;
      }
      if (isPinKey(e) && (pinned || latest.current.shown())) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (pinned) release();
        else setPinned(true);
      } else if (pinned && e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation(); // Escape would also cancel a running request
        release();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (pinned && !box.current?.contains(e.target as Node)) release();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [pinned]);
  return [pinned, setPinned];
}

/**
 * How a rich tooltip behaves (the header's about, RichTip): CSS shows it after a short rest of the pointer on `wrap`
 * or on keyboard focus (:focus-visible) inside it; Escape hides it, and only that, until the pointer or the focus
 * comes back; Alt+P pins it (usePin), and non-link/non-button targets can also toggle pinning on click.
 */
export function useTip(wrap: { current: HTMLElement | null }, clickPin = false) {
  const [dismissed, setDismissed] = useState(false);
  const dismissedRef = useRef(false);
  dismissedRef.current = dismissed;
  const shown = () => {
    const el = wrap.current;
    const tip = el?.querySelector('[role="tooltip"]');
    return !!el && !dismissedRef.current && !el.closest('[inert]') && (el.matches(':hover') || !!el.querySelector(':focus-visible'))
      && (!tip || getComputedStyle(tip).visibility !== 'hidden');
  };
  const [pinned, setPinned] = usePin(shown, wrap, () => setDismissed(true));
  const pinnedRef = useRef(false);
  pinnedRef.current = pinned;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || pinnedRef.current || !shown()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setDismissed(true);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  return {
    pinned,
    setPinned,
    state: pinned ? ' pinned' : dismissed ? ' dismissed' : '',
    onMouseEnter: () => setDismissed(false),
    onFocusIn: (e: FocusEvent) => {
      if ((e.target as Element | null)?.matches?.(':focus-visible')) setDismissed(false);
    },
    onTargetClick: clickPin
      ? (e: MouseEvent) => {
          e.stopPropagation();
          if (pinnedRef.current) {
            setPinned(false);
            setDismissed(true);
          } else {
            setDismissed(false);
            setPinned(true);
          }
        }
      : undefined,
  };
}

/**
 * A small rich tooltip below `children`, which it makes focusable and described by it. For non-link, non-button
 * elements (`clickPin = true`, the default), clicking the target also pins/unpins the tooltip.
 */
export function RichTip({ tip, children, testId, clickPin = true, onOpen, className }: {
  tip: ComponentChildren; children: ComponentChildren; testId?: string; clickPin?: boolean;
  onOpen?: () => void; className?: string;
}) {
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const { pinned, state, onMouseEnter, onFocusIn, onTargetClick } = useTip(wrap, clickPin);
  const [side, setSide] = useState('');
  const place = () => {
    const el = wrap.current;
    const box = el?.querySelector('.rab-n-tip') as HTMLElement | null;
    const app = el?.closest('.rab-n');
    if (!el || !box || !app) return;
    const r = el.getBoundingClientRect();
    const a = app.getBoundingClientRect();
    const w = box.offsetWidth;
    const h = box.offsetHeight + 10;
    const up = r.bottom + h > a.bottom - 8 && r.top - h >= a.top + 8;
    const clampedLeft = Math.max(a.left + 8, Math.min(r.left, a.right - w - 8));
    box.style.left = Math.round(clampedLeft - r.left) + 'px';
    box.style.right = 'auto';
    setSide(up ? ' above' : '');
  };
  useEffect(() => {
    place();
  }, [tip]);
  return (
    <span ref={wrap} class={'rab-n-tip-wrap' + state + side + (className ? ' ' + className : '')}
          onMouseEnter={() => { onOpen?.(); place(); onMouseEnter(); }}
          onFocusIn={(e) => { onOpen?.(); place(); onFocusIn(e); }}>
      <span
        class={'rab-n-tip-target' + (clickPin ? ' is-clickable' : '')}
        tabIndex={0}
        aria-describedby={id}
        onClick={onTargetClick ? (e) => { onOpen?.(); place(); onTargetClick(e); } : undefined}
      >
        {children}
      </span>
      <span id={id} class="rab-n-tip" role="tooltip" data-testid={testId}>
        {tip}
        <PinHint pinned={pinned} clickable={clickPin} />
      </span>
    </span>
  );
}

/** The last line of a rich tooltip: how to pin it, or how to let it go. */
export function PinHint({ pinned, clickable }: { pinned: boolean; clickable?: boolean }) {
  return (
    <span class={'rab-n-pin-hint' + (pinned ? ' pinned' : '')} data-testid="pin-hint">
      <svg class="rab-n-svg" width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {pinned
        ? <span>Pinned: <kbd>Esc</kbd> or a click outside closes it</span>
        : clickable
          ? <span>Click or <kbd>Alt</kbd>+<kbd>P</kbd> pins it</span>
          : <span><kbd>Alt</kbd>+<kbd>P</kbd> pins it</span>}
    </span>
  );
}

export function WarnGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg class="rab-n-svg" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2.4l6 10.6H2L8 2.4z" fill="currentColor" fillOpacity="0.16" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M8 6.6v2.9M8 11.4v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** The form's mark beside a value: a warning sign with the reason, a green check once it is fine; the slot stays when empty. */
export function CheckMark({ check }: { check: Check }) {
  if (!check) return <span class="rab-n-check" aria-hidden="true" />;
  const ok = check.state === 'ok';
  return (
    <span class={'rab-n-check ' + (ok ? 'is-ok' : 'is-warn')} title={check.message} role="img" aria-label={check.message}
          data-testid="check" data-state={check.state}>
      {ok ? (
        <svg class="rab-n-svg" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.4 8.6l2.9 2.9 6.3-6.6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <WarnGlyph />
      )}
    </span>
  );
}

/** The id of a tab of `Tabs` with this panel id; the panel names its selected tab with it (aria-labelledby). */
export const tabId = (panelId: string, id: string) => panelId + '-tab-' + id;

export function Tabs<T extends string>({ tabs, value, onChange, label, panelId }: {
  tabs: { id: T; label: ComponentChildren }[]; value: T; onChange: (id: T) => void;
  /** The tab list's accessible name. */
  label?: string;
  /** The id of the panel the tabs show (role="tabpanel", aria-labelledby={tabId(panelId, value)}). */
  panelId?: string;
}) {
  const at = tabs.findIndex((t) => t.id === value);
  // arrow keys move between tabs; only the selected tab (or the first, when none is) is in the Tab order
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const i = Math.max(0, at);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (next === null || !tabs.length) return;
    e.preventDefault();
    const t = tabs[(next + tabs.length) % tabs.length];
    onChange(t.id);
    const list = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => (list.querySelector('[aria-selected="true"]') as HTMLElement | null)?.focus());
  };
  return (
    <div class="rab-n-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t, idx) => (
        <button
          key={t.id}
          id={panelId ? tabId(panelId, t.id) : undefined}
          role="tab"
          aria-selected={t.id === value}
          aria-controls={panelId}
          tabIndex={t.id === value || (at < 0 && idx === 0) ? 0 : -1}
          class={'rab-n-tab' + (t.id === value ? ' on' : '')}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Copies text: the Clipboard API, else an invisible textarea (older browsers, no permission); true when it worked. */
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const focused = document.activeElement as HTMLElement | null;
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    focused?.focus();
    return ok;
  }
}

export function CopyButton({ text, label, testId, quiet, disabled, title }: {
  text: () => string; label: string; testId?: string; quiet?: boolean;
  /** Nothing to copy: the button is disabled and `title` says why. */
  disabled?: boolean; title?: string;
}) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const flash = useFlash<'done' | 'failed'>(setState);
  const copy = async () => {
    const value = text();
    flash(value !== '' && (await copyText(value)) ? 'done' : 'failed');
  };
  return (
    <button class={(quiet ? 'rab-n-quiet' : 'rab-n-button') + ' rab-n-copy' + (state === 'done' ? ' copied' : state === 'failed' ? ' failed' : '')}
            onClick={copy} disabled={disabled} title={title} data-testid={testId} data-state={state}>
      {state === 'done' ? (
        <svg class="rab-n-svg" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.2 8.4l3 3 6.6-6.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg class="rab-n-svg" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10.5 5.5V4a1.5 1.5 0 00-1.5-1.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      )}
      {state === 'done' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </button>
  );
}

/**
 * A short feedback state (copied, failed) that goes back to idle after 1.5 s; safe after the component is gone,
 * when a copy finishes late (the clipboard can take a while to answer).
 */
export function useFlash<S extends string>(set: (s: S | 'idle') => void): (s: S) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  return (s: S) => {
    if (!live.current) return;
    set(s);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => live.current && set('idle'), 1500);
  };
}

/** "1 module", "3 modules": a count with its noun, singular or plural. */
export const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** A link target that is safe to open: http(s) only, never javascript: or data: (plugin descriptors are not trusted). */
export const safeHref = (url?: string) => (url && /^https?:\/\//i.test(url.trim()) ? url.trim() : undefined);

export function formatBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
