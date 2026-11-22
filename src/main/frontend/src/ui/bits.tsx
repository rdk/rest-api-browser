import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { pathParts } from '../core/pathparts';
import type { Check } from '../core/validate';

export const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function MethodBadge({ method }: { method: string }) {
  const m = method.toUpperCase();
  const cls = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m) ? m.toLowerCase() : 'other';
  return <span class={'rab-n-method rab-n-method-' + cls}>{m === 'DELETE' ? 'DEL' : m}</span>;
}

/**
 * A path with its parts told apart: the resource words in the text color, separators, versions and the module prefix
 * fainter, {templates} in their own color, the search's words marked.
 */
export function PathText({ path, prefix, words }: { path: string; prefix?: number; words?: string[] }) {
  return (
    <>
      {pathParts(path, { prefix, words }).map((p, i) =>
        p.kind === 'text' && !p.hit ? p.text : <span key={i} class={'rab-n-pp-' + p.kind + (p.hit ? ' rab-n-pp-hit' : '')}>{p.text}</span>,
      )}
    </>
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

export function Tabs<T extends string>({ tabs, value, onChange }: {
  tabs: { id: T; label: ComponentChildren }[]; value: T; onChange: (id: T) => void;
}) {
  // arrow keys move between tabs; only the selected tab is in the Tab order
  const onKeyDown = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === value);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -2;
    if (next === -2 || !tabs.length) return;
    e.preventDefault();
    const t = tabs[(next + tabs.length) % tabs.length];
    onChange(t.id);
    const list = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => (list.querySelector('[aria-selected="true"]') as HTMLElement | null)?.focus());
  };
  return (
    <div class="rab-n-tabs" role="tablist" onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === value}
          tabIndex={t.id === value ? 0 : -1}
          class={'rab-n-tab' + (t.id === value ? ' on' : '')}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function CopyButton({ text, label, testId }: { text: () => string; label: string; testId?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    const value = text();
    let ok = true;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // older browsers or a page without clipboard permission: an invisible textarea, focus given back afterwards
      const focused = document.activeElement as HTMLElement | null;
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.appendChild(area);
      area.select();
      ok = document.execCommand('copy');
      area.remove();
      focused?.focus();
    }
    setState(ok ? 'done' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1500);
  };
  return (
    <button class={'rab-n-button rab-n-copy' + (state === 'done' ? ' copied' : '')} onClick={copy} data-testid={testId}>
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
