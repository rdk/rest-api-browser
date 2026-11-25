import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { fetchClassInfo, type ClassInfo, type ClassQuery } from '../core/details';
import { classLabel, parseJavaTypeParts } from '../core/javarefs';
import { formatBytes, PinHint, plural, usePin } from './bits';
import { originLabel } from './facts';
import type { Module } from '../core/types';
import type { OpenTabRequest } from '../core/sourcetabs';

/**
 * Clickable Java type expression (e.g. "java.util.List<com.example.Foo>") where every non-primitive class token
 * triggers the shared rich class tooltip on hover/focus and opens the decompiler dialog on click.
 */
export function JavaTypeExpr({ typeExpr, full = false, fromBundle, opKey, onOpenClass, className }: {
  typeExpr: string;
  full?: boolean;
  fromBundle?: number;
  opKey?: string;
  onOpenClass?: (req: OpenTabRequest) => void;
  className?: string;
}) {
  const parts = parseJavaTypeParts(typeExpr, full);
  if (!onOpenClass) {
    return <span class={className}>{parts.map((p) => p.text).join('')}</span>;
  }
  return (
    <span class={className}>
      {parts.map((p, i) =>
        p.fqcn ? (
          <button
            key={i}
            type="button"
            class="rab-n-jc-link rab-n-jc-type"
            data-class-ref={p.fqcn}
            data-class-candidates={p.fqcn}
            data-class-bundle={fromBundle !== undefined && fromBundle >= 0 ? String(fromBundle) : undefined}
            data-class-op={opKey}
            onClick={(e) => {
              e.stopPropagation();
              onOpenClass({ target: p.fqcn!, candidates: [p.fqcn!], fromBundle, opKey });
            }}
          >
            {p.text}
          </button>
        ) : (
          p.text
        ),
      )}
    </span>
  );
}

/** Single clickable Java class link carrying the data attributes for the shared rich class tooltip. */
export function JavaTypeButton({ fqcn, candidates, fromBundle, opKey, onOpenClass, kind = 'type', children, className }: {
  fqcn: string;
  candidates?: string[];
  fromBundle?: number;
  opKey?: string;
  onOpenClass: (req: OpenTabRequest) => void;
  kind?: 'type' | 'ann';
  children?: ComponentChildren;
  className?: string;
}) {
  const list = candidates && candidates.length ? candidates : [fqcn];
  return (
    <button
      type="button"
      class={'rab-n-jc-link rab-n-jc-' + kind + (className ? ' ' + className : '')}
      data-class-ref={fqcn}
      data-class-candidates={list.join(',')}
      data-class-bundle={fromBundle !== undefined && fromBundle >= 0 ? String(fromBundle) : undefined}
      data-class-op={opKey}
      onClick={(e) => {
        e.stopPropagation();
        onOpenClass({ target: fqcn, candidates: list, fromBundle, opKey });
      }}
    >
      {children ?? classLabel(fqcn)}
    </button>
  );
}

interface HoverTarget {
  el: HTMLElement;
  fqcn: string;
  query: ClassQuery;
  rect: DOMRect;
}

const HOVER_DELAY_MS = 260;

/**
 * Shared floating rich tooltip for any `[data-class-ref]` element anywhere in the app (REST params, input/output
 * types, Java tab, and decompiled source both inline and in the tabbed dialog).
 * <p>
 * Fetches `/rest/restbrowser/1/code/class` on demand (cached), supports Alt+P pinning (`usePin`) and Escape dismissal
 * (capture phase, before closing any dialog).
 */
export function ClassHoverCard({ baseUrl, enabled, rootRef, onOpenClass }: {
  baseUrl: string;
  enabled: boolean;
  rootRef: { current: HTMLElement | null };
  onOpenClass: (req: OpenTabRequest) => void;
}) {
  const [target, setTarget] = useState<HoverTarget | null>(null);
  const [info, setInfo] = useState<ClassInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HoverTarget | null>(null);
  targetRef.current = target;
  const pinnedRef = useRef(false);

  const pinned = usePin(
    () => !!targetRef.current,
    boxRef,
    () => setTarget(null),
  );
  pinnedRef.current = pinned;

  // Escape dismisses an unpinned tooltip before any outer dialog or page handler sees it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || pinnedRef.current || !targetRef.current) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setTarget(null);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  // Delegated hover & keyboard focus listener across the whole app root
  useEffect(() => {
    if (!enabled) {
      setTarget(null);
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;

    const readEl = (el: HTMLElement): HoverTarget | null => {
      const fqcn = el.getAttribute('data-class-ref')?.trim();
      if (!fqcn) return null;
      const rawCands = el.getAttribute('data-class-candidates');
      const classCandidates = rawCands ? rawCands.split(',').map((s) => s.trim()).filter(Boolean) : [fqcn];
      const rawBundle = el.getAttribute('data-class-bundle');
      const fromBundle = rawBundle && /^-?\d+$/.test(rawBundle) ? Number(rawBundle) : undefined;
      const op = el.getAttribute('data-class-op') || undefined;
      return { el, fqcn, query: { classCandidates, fromBundle, op }, rect: el.getBoundingClientRect() };
    };

    const scheduleShow = (el: HTMLElement, delay: number) => {
      clearTimeout(hideTimer);
      clearTimeout(timer);
      if (pinnedRef.current) return;
      const next = readEl(el);
      if (!next) return;
      if (delay <= 0) {
        setTarget(next);
        return;
      }
      timer = setTimeout(() => {
        if (!pinnedRef.current && el.isConnected) {
          setTarget({ ...next, rect: el.getBoundingClientRect() });
        }
      }, delay);
    };

    const scheduleHide = () => {
      clearTimeout(timer);
      if (pinnedRef.current) return;
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!pinnedRef.current) setTarget(null);
      }, 90);
    };

    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-class-ref]') as HTMLElement | null;
      if (!el || el.closest('[inert]')) return;
      if (targetRef.current?.el === el) {
        clearTimeout(hideTimer);
        return;
      }
      scheduleShow(el, HOVER_DELAY_MS);
    };

    const onOut = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-class-ref]') as HTMLElement | null;
      if (!el) return;
      const related = e.relatedTarget as Node | null;
      if (related && (el.contains(related) || boxRef.current?.contains(related))) return;
      scheduleHide();
    };

    const onFocusIn = (e: FocusEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-class-ref]') as HTMLElement | null;
      if (!el || !el.matches(':focus-visible') || el.closest('[inert]')) return;
      scheduleShow(el, 0);
    };

    const onFocusOut = (e: FocusEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-class-ref]') as HTMLElement | null;
      if (!el) return;
      const related = e.relatedTarget as Node | null;
      if (related && boxRef.current?.contains(related)) return;
      if (!pinnedRef.current) setTarget(null);
    };

    const onClick = () => {
      clearTimeout(timer);
      if (!pinnedRef.current) setTarget(null);
    };

    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseout', onOut);
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    root.addEventListener('mousedown', onClick);
    return () => {
      clearTimeout(timer);
      clearTimeout(hideTimer);
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseout', onOut);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      root.removeEventListener('mousedown', onClick);
    };
  }, [enabled, rootRef]);

  // Fetch class metadata whenever the target changes
  useEffect(() => {
    if (!target) {
      setInfo(null);
      setError(null);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    setInfo(null);
    fetchClassInfo(baseUrl, target.query).then(
      (data) => {
        if (!live) return;
        setInfo(data);
        setLoading(false);
      },
      (e) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [baseUrl, target]);

  // Keep the floating card inside the viewport
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || !target) return;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const r = target.rect;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = Math.min(r.left, vw - w - 10);
    x = Math.max(10, x);
    let y = r.bottom + 8;
    if (y + h > vh - 10 && r.top - h - 8 >= 10) {
      y = r.top - h - 8;
    } else if (y + h > vh - 10) {
      y = Math.max(10, vh - h - 10);
    }
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
  }, [target, info, loading, error]);

  if (!target) return null;

  const pluginDates = info?.plugin
    ? ([['Installed', info.plugin.installed], ['Loaded', info.plugin.loaded], ['Enabled', info.plugin.enabled]]
      .filter(([, v]) => v) as [string, string][])
    : [];

  return (
    <div
      ref={boxRef}
      class={'rab-n-class-tip' + (pinned ? ' pinned' : '')}
      role="tooltip"
      data-testid="class-hover-card"
      style={{ left: Math.round(target.rect.left) + 'px', top: Math.round(target.rect.bottom + 8) + 'px' }}
    >
      <div class="rab-n-class-tip-body">
        <div class="rab-n-class-tip-head">
          {info && <span class={'rab-n-class-kind kind-' + info.kind}>{info.kind}</span>}
          <strong class="rab-n-class-tip-name">{info ? info.simpleName : classLabel(target.fqcn)}</strong>
          {info?.deprecated && <span class="rab-n-tag rab-n-tag-deprecated">Deprecated</span>}
        </div>
        <div class="rab-n-class-tip-fqcn">{info?.name ?? target.fqcn}</div>
        {loading && (
          <div class="rab-n-subtle rab-n-class-tip-status">
            <span class="rab-n-spinner" aria-hidden="true" /> Inspecting class &amp; OSGi metadata…
          </div>
        )}
        {error && !loading && (
          <div class="rab-n-card-error rab-n-class-tip-status">Could not inspect: {error}</div>
        )}
        {info && (
          <dl class="rab-n-card-facts rab-n-class-tip-facts">
            {info.modifiers && <Row name="Modifiers"><span class="rab-n-card-mono">{info.modifiers}</span></Row>}
            {info.superclasses.length > 0 && (
              <Row name="Extends"><span class="rab-n-card-mono">{info.superclasses.map(classLabel).join(' → ')}</span></Row>
            )}
            {info.interfaces.length > 0 && (
              <Row name="Implements">
                <span class="rab-n-card-mono">
                  {info.interfaces.slice(0, 4).map(classLabel).join(', ')}
                  {info.interfaces.length > 4 && ` +${info.interfaces.length - 4}`}
                </span>
              </Row>
            )}
            <Row name="Members">
              {plural(info.methodCount, 'method')}, {plural(info.fieldCount, 'field')}, {plural(info.constructorCount, 'ctor')}
              {info.innerClasses.length > 0 && `, ${plural(info.innerClasses.length, 'inner')}`}
              {info.refCount > 0 && ` · ${plural(info.refCount, 'ref')}`}
            </Row>
            {(info.bytecodeVersion || info.bytecodeBytes > 0) && (
              <Row name="Bytecode">
                {[info.bytecodeVersion, info.bytecodeBytes > 0 ? formatBytes(info.bytecodeBytes) : ''].filter(Boolean).join(' · ')}
              </Row>
            )}
            {info.plugin && (
              <>
                <Row name="Plugin">
                  <strong>{info.plugin.name}</strong>
                  <div class="rab-n-card-mono rab-n-card-note">
                    {info.plugin.key}{info.plugin.version ? ' ' + info.plugin.version : ''}
                  </div>
                  <div class="rab-n-card-note">
                    {[
                      info.plugin.origin ? originLabel({ origin: info.plugin.origin } as Module) : '',
                      info.plugin.state,
                      info.plugin.vendor ?? '',
                    ].filter(Boolean).join(' · ')}
                  </div>
                </Row>
                {info.plugin.artifact && <Row name="Artifact"><span class="rab-n-card-mono">{info.plugin.artifact}</span></Row>}
                {pluginDates.length > 0 && (
                  <Row name="Plugin times">
                    {pluginDates.map(([k, d], i) => (
                      <div key={k} class="rab-n-card-note">{i > 0 ? '' : ''}{k}: {formatTime(d)}</div>
                    ))}
                  </Row>
                )}
              </>
            )}
            {info.bundle ? (
              <>
                <Row name="OSGi bundle">
                  <span class="rab-n-card-mono">#{info.bundle.id} {info.bundle.symbolicName} {info.bundle.version}</span>
                  <div class="rab-n-card-note">
                    <span class={info.bundle.state === 'ACTIVE' ? 'rab-n-java-ok' : 'rab-n-java-deprecated'}>{info.bundle.state}</span>
                    {info.bundle.fragment ? ' · fragment' : ''}
                    {info.bundle.importCount !== undefined && ` · ${info.bundle.importCount} imp / ${info.bundle.exportCount ?? 0} exp`}
                  </div>
                </Row>
                {info.bundle.packageExported !== undefined && (
                  <Row name="OSGi package">
                    {info.bundle.packageExported
                      ? `Exported (wired to ${plural(info.bundle.packageExportUsers ?? 0, 'bundle')})`
                      : 'Private to bundle (not exported)'}
                  </Row>
                )}
                {info.bundle.lastModified > 0 && (
                  <Row name="Bundle modified">{new Date(info.bundle.lastModified).toLocaleString()}</Row>
                )}
                {info.bundle.headers['Atlassian-Build-Date'] && (
                  <Row name="Build date">{info.bundle.headers['Atlassian-Build-Date']}</Row>
                )}
              </>
            ) : (
              <Row name="Origin">{info.origin}</Row>
            )}
            <Row name="ClassLoader"><span class="rab-n-card-mono">{info.classLoader}</span></Row>
            {info.codeSource && <Row name="CodeSource"><span class="rab-n-card-mono">{info.codeSource}</span></Row>}
          </dl>
        )}
        <div class="rab-n-class-tip-foot">
          {pinned ? (
            <button
              type="button"
              class="rab-n-quiet rab-n-class-tip-open"
              onClick={() => {
                onOpenClass({
                  target: info?.name ?? target.fqcn,
                  candidates: target.query.classCandidates,
                  fromBundle: info && info.bundleId >= 0 ? info.bundleId : target.query.fromBundle,
                  opKey: target.query.op,
                });
                setTarget(null);
              }}
            >
              Decompile class →
            </button>
          ) : (
            <span class="rab-n-card-note">Click to decompile</span>
          )}
          {info && (
            <span class="rab-n-card-note">
              {info.cached ? 'cached' : info.inspectMs !== undefined ? `${info.inspectMs} ms` : ''}
            </span>
          )}
        </div>
        <PinHint pinned={pinned} />
      </div>
    </div>
  );
}

function Row({ name, children }: { name: string; children: ComponentChildren }) {
  return (
    <>
      <dt>{name}</dt>
      <dd>{children}</dd>
    </>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
