import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { fetchClassInfo, type ClassInfo, type ClassQuery } from '../../core/details';
import { formatIsoTime } from '../../core/detailserror';
import { classLabel } from '../../lib/java-source';
import type { OpenTabRequest } from '../../core/sourcetabs';
import type { Module } from '../../core/types';
import { originLabel } from '../../core/facts';
import { ESCAPE_PRIORITY, isInsideInert, onInertChange, useEscape } from '../../lib/overlay';
import { formatBytes, PinHint, plural, usePin } from '../bits';

const PINNED_TIP_SELECTOR = '[data-testid=ui-tip].pinned, .rab-n-tip-wrap.pinned, .rab-n-brand-wrap.pinned, #rab-n-row-card.pinned';

interface HoverTarget {
  el: HTMLElement;
  fqcn: string;
  alreadyOpen: boolean;
  query: ClassQuery;
  rect: DOMRect;
}

const HOVER_DELAY_MS = 260;

/**
 * Shared floating rich tooltip for any `[data-class-ref]` element anywhere in the app (REST params, input/output
 * types, Java tab, and decompiled source both inline and in the tabbed dialog).
 * Fetches `/rest/restbrowser/1/code/class` on demand (cached), supports Alt+P pinning (`usePin`) and Escape dismissal.
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

  const [pinned, setPinned] = usePin(
    () => !!targetRef.current && !isInsideInert(targetRef.current.el),
    boxRef,
    () => setTarget(null),
    () => isInsideInert(targetRef.current?.el),
  );
  pinnedRef.current = pinned;

  useEscape(!!target && !pinned, () => {
    if (isInsideInert(targetRef.current?.el)) {
      setTarget(null);
      return false;
    }
    setTarget(null);
    return true;
  }, ESCAPE_PRIORITY.TOOLTIP);

  useEffect(() => {
    if (!target) return;
    const dismissIfInert = () => {
      if (targetRef.current && isInsideInert(targetRef.current.el)) {
        setPinned(false);
        setTarget(null);
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
  }, [!!target, rootRef, setPinned]);

  useEffect(() => {
    if (!enabled) {
      setPinned(false);
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
      return {
        el,
        fqcn,
        alreadyOpen: el.getAttribute('data-class-open') === 'true',
        query: { classCandidates, fromBundle, op },
        rect: el.getBoundingClientRect(),
      };
    };

    const scheduleShow = (el: HTMLElement, delay: number) => {
      clearTimeout(hideTimer);
      clearTimeout(timer);
      if (pinnedRef.current || root.querySelector(PINNED_TIP_SELECTOR)) return;
      const next = readEl(el);
      if (!next) return;
      if (delay <= 0) {
        setTarget(next);
        return;
      }
      timer = setTimeout(() => {
        if (!pinnedRef.current && el.isConnected && !isInsideInert(el) && !root.querySelector(PINNED_TIP_SELECTOR)) {
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

    const hideNow = () => {
      clearTimeout(timer);
      clearTimeout(hideTimer);
      if (!pinnedRef.current) setTarget(null);
    };

    const onOver = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      const el = t?.closest?.('[data-class-ref]') as HTMLElement | null;
      if (!el || isInsideInert(el)) {
        clearTimeout(timer);
        if (!pinnedRef.current && targetRef.current && !t?.closest?.('.rab-n-class-tip')) {
          clearTimeout(hideTimer);
          setTarget(null);
        }
        return;
      }
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
      if (targetRef.current && isInsideInert(targetRef.current.el)) {
        setPinned(false);
        setTarget(null);
      }
      const el = (e.target as HTMLElement | null)?.closest?.('[data-class-ref]') as HTMLElement | null;
      if (!el || !el.matches(':focus-visible') || isInsideInert(el)) return;
      scheduleShow(el, 0);
    };

    const onFocusOut = (e: FocusEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-class-ref]') as HTMLElement | null;
      if (!el) return;
      const related = e.relatedTarget as Node | null;
      if (related && boxRef.current?.contains(related)) return;
      if (!pinnedRef.current) setTarget(null);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && boxRef.current?.contains(e.target)) return;
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
      clearTimeout(timer);
      clearTimeout(hideTimer);
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseout', onOut);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      root.removeEventListener('pointerdown', onPointerDown, true);
      root.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', hideNow);
    };
  }, [enabled, rootRef, setPinned]);

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
  }, [target, info, loading, error, pinned]);

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
                    {pluginDates.map(([k, d]) => (
                      <div key={k} class="rab-n-card-note">{k}: {formatIsoTime(d)}</div>
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
                  <Row name="Bundle modified">{formatIsoTime(info.bundle.lastModified)}</Row>
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
                setPinned(false);
                setTarget(null);
              }}
            >
              Decompile class →
            </button>
          ) : (
            <span class="rab-n-card-note">{target.alreadyOpen ? 'Currently open in decompiler' : 'Click to decompile'}</span>
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
