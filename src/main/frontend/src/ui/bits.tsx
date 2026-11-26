import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { pathParts } from '../lib/jaxrs-router';
import type { Check } from '../core/validate';
import { tipProps, type UiTipSpec } from '../core/uitips';
import { acquireInert, ESCAPE_PRIORITY, isInsideInert, onInertChange, useEscape } from '../lib/overlay';

export { acquireInert };

export const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const METHOD_TIPS: Record<string, UiTipSpec> = {
  GET: { title: 'HTTP GET', body: 'Read-only request that retrieves data without modifying server state.' },
  HEAD: { title: 'HTTP HEAD', body: 'Read-only request that returns response headers without a body.' },
  OPTIONS: { title: 'HTTP OPTIONS', body: 'Read-only request that queries supported HTTP methods and CORS options.' },
  POST: { title: 'HTTP POST', body: 'Write request that creates a resource or triggers an action on the server.', tone: 'warn' },
  PUT: { title: 'HTTP PUT', body: 'Write request that creates or completely replaces a target resource.', tone: 'warn' },
  PATCH: { title: 'HTTP PATCH', body: 'Write request that applies a partial update to an existing resource.', tone: 'warn' },
  DELETE: { title: 'HTTP DELETE', body: 'Destructive write request that removes the target resource on the server.', tone: 'danger' },
};

export function MethodBadge({ method, showTip = false }: { method: string; showTip?: boolean }) {
  const m = method.toUpperCase();
  const cls = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m) ? m.toLowerCase() : 'other';
  const tip = showTip ? tipProps(METHOD_TIPS[m] ?? { title: `HTTP ${m}`, body: `Sends an HTTP ${m} request.` }) : {};
  return m === 'DELETE'
    ? <span class={'rab-n-method rab-n-method-' + cls} {...tip}><span aria-hidden="true">DEL</span><span class="rab-n-sr">DELETE</span></span>
    : <span class={'rab-n-method rab-n-method-' + cls} {...tip}>{m}</span>;
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

/** The button that makes a box take the whole screen, and gives it back its place (Escape unless overridden). */
export function MaximizeButton({ on, onToggle, what, testId, shortcut, tip }: {
  on: boolean; onToggle: () => void; what: string; testId: string; shortcut?: string; tip?: UiTipSpec;
}) {
  const resolvedShortcut = shortcut === undefined ? (on ? 'Esc' : undefined) : (shortcut || undefined);
  const label = on
    ? (resolvedShortcut ? `Restore the ${what} (${resolvedShortcut})` : `Restore the ${what}`)
    : `Show the ${what} on the whole screen`;
  const resolvedTip: UiTipSpec = tip ?? (on
    ? { title: `Restore ${what}`, body: `Return the ${what} to its normal size.`, shortcut: resolvedShortcut }
    : { title: `Maximize ${what}`, body: `Expand the ${what} to fill the viewport.` });
  return (
    <button
      class={'rab-n-tool' + (on ? ' on' : '')}
      onClick={onToggle}
      aria-label={label}
      aria-pressed={on}
      data-testid={testId}
      data-state={on ? 'max' : 'normal'}
      {...tipProps(resolvedTip)}
    >
      <svg class="rab-n-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d={on ? 'M6 2.5v3.5H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5' : 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10'}
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/** The key that pins a rich tooltip: Alt+P (by key position, so Option+P on a Mac works too). */
export const isPinKey = (e: KeyboardEvent) => e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyP';

let releaseActivePin: (() => void) | null = null;

/**
 * Pinning of a rich tooltip (the list's hover card, the header's about): Alt+P while it shows pins it, so it stays
 * and takes the pointer (its text can be selected, its links clicked); a click outside `box`, Escape or Alt+P again
 * lets it go, and `onRelease` hides it. Coordinates globally so only one tooltip is pinned at a time.
 */
export function usePin(
  shown: () => boolean,
  box: { current: HTMLElement | null },
  onRelease?: () => void,
  isInert?: () => boolean,
): [boolean, (next: boolean) => void] {
  const [pinned, setPinned] = useState(false);
  const latest = useRef({ shown, onRelease, isInert });
  latest.current = { shown, onRelease, isInert };

  const inert = () => (latest.current.isInert ? latest.current.isInert() : isInsideInert(box.current));

  const releaseRef = useRef<() => void>(() => undefined);
  const pinTokenRef = useRef<(() => void) | null>(null);
  if (!pinTokenRef.current) {
    pinTokenRef.current = () => releaseRef.current();
  }

  const setPin = (next: boolean) => {
    const token = pinTokenRef.current!;
    if (next) {
      const prev = releaseActivePin;
      releaseActivePin = token;
      if (prev && prev !== token) prev();
    } else if (releaseActivePin === token) {
      releaseActivePin = null;
    }
    setPinned(next);
  };

  const release = () => {
    setPin(false);
    latest.current.onRelease?.();
  };
  releaseRef.current = release;

  useEffect(() => () => {
    if (releaseActivePin === pinTokenRef.current) releaseActivePin = null;
  }, []);

  useEscape(pinned, () => {
    if (inert()) {
      release();
      return false;
    }
    release();
    return true;
  }, ESCAPE_PRIORITY.TOOLTIP);

  useEffect(() => {
    const token = pinTokenRef.current!;
    if (pinned) {
      const prev = releaseActivePin;
      releaseActivePin = token;
      if (prev && prev !== token) prev();
    }
    const onKey = (e: KeyboardEvent) => {
      if (inert()) {
        if (pinned) release();
        return;
      }
      if (isPinKey(e) && (pinned || latest.current.shown())) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (pinned) release();
        else setPin(true);
      }
    };
    const onDown = (e: PointerEvent) => {
      if (pinned && (inert() || !box.current?.contains(e.target as Node))) release();
    };
    const onFocusIn = () => {
      if (pinned && inert()) release();
    };
    const offInert = pinned ? onInertChange(() => {
      if (inert()) release();
    }) : undefined;
    const obs = pinned && typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => {
        if (inert()) release();
      })
      : null;
    if (obs && typeof document !== 'undefined' && document.body) {
      obs.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['inert'] });
    }
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      offInert?.();
      obs?.disconnect();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, [pinned]);
  return [pinned, setPin];
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
    return !!el && !dismissedRef.current && !isInsideInert(el) && (el.matches(':hover') || !!el.querySelector(':focus-visible'))
      && (!tip || getComputedStyle(tip).visibility !== 'hidden');
  };
  const [pinned, setPinned] = usePin(shown, wrap, () => setDismissed(true));
  const pinnedRef = useRef(false);
  pinnedRef.current = pinned;

  useEscape(!dismissed && !pinned, () => {
    if (!shown()) return false;
    setDismissed(true);
    return true;
  }, ESCAPE_PRIORITY.TOOLTIP);

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
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    if (pinned || el.matches(':hover') || el.querySelector(':focus-visible')) place();
  }, [tip, pinned]);
  return (
    <span ref={wrap} class={'rab-n-tip-wrap' + state + side + (className ? ' ' + className : '')}
          onMouseEnter={() => { onOpen?.(); place(); onMouseEnter(); }}
          onFocusIn={(e) => { onOpen?.(); place(); onFocusIn(e); }}>
      <span
        class={'rab-n-tip-target' + (clickPin ? ' is-clickable' : '')}
        role={clickPin ? 'button' : undefined}
        aria-pressed={clickPin ? pinned : undefined}
        tabIndex={0}
        aria-describedby={id}
        onClick={onTargetClick ? (e) => { onOpen?.(); place(); onTargetClick(e); } : undefined}
        onKeyDown={onTargetClick ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen?.();
            place();
            onTargetClick(e as unknown as MouseEvent);
          }
        } : undefined}
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
    <span
      class={'rab-n-check ' + (ok ? 'is-ok' : 'is-warn')}
      role="img"
      aria-label={check.message}
      data-testid="check"
      data-state={check.state}
      {...tipProps({
        title: ok ? 'Valid parameter' : 'Validation warning',
        body: check.message,
        tone: ok ? undefined : 'warn',
      })}
    >
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
  tabs: { id: T; label: ComponentChildren; tip?: UiTipSpec }[]; value: T; onChange: (id: T) => void;
  /** The tab list's accessible name. */
  label?: string;
  /** The id of the panel the tabs show (role="tabpanel", aria-labelledby={tabId(panelId, value)}). */
  panelId?: string;
}) {
  const at = tabs.findIndex((t) => t.id === value);
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
          {...tipProps(t.tip)}
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
    try {
      area.select();
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      area.remove();
      focused?.focus();
    }
  }
}

export function CopyButton({ text, label, testId, quiet, disabled, title, tip }: {
  text: () => string; label: string; testId?: string; quiet?: boolean;
  /** Nothing to copy: the button is disabled and `title` or `tip` says why. */
  disabled?: boolean; title?: string; tip?: UiTipSpec;
}) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const flash = useFlash<'done' | 'failed'>(setState);
  const copy = async () => {
    const value = text();
    flash(value !== '' && (await copyText(value)) ? 'done' : 'failed');
  };
  const resolvedTip: UiTipSpec = tip ?? {
    title: label,
    body: title ?? `Copy ${label.replace(/^Copy\s+/i, '').toLowerCase()} to your clipboard.`,
    tone: disabled ? 'warn' : undefined,
  };
  return (
    <button class={(quiet ? 'rab-n-quiet' : 'rab-n-button') + ' rab-n-copy' + (state === 'done' ? ' copied' : state === 'failed' ? ' failed' : '')}
            onClick={copy} disabled={disabled} data-testid={testId} data-state={state} {...tipProps(resolvedTip)}>
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
