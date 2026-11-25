import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  DetailsError, fetchSource, forgetSource,
  type DecompilerId, type OperationSource,
} from '../core/details';
import { splitSourceLines } from '../core/javatokens';
import { classLabel, createRefContext, findMethodHeaderLine, linkSourceLine, type SourceSpan } from '../core/javarefs';
import type { OpenTabRequest, SourceTab, SourceTabsState } from '../core/sourcetabs';
import { CopyButton, MaximizeButton } from './bits';
import { VirtualList } from './VirtualList';

export type { SourceTab };

const SOURCE_LINE_HEIGHT = 20;
const MIN_MODAL_W = 460;
const MIN_MODAL_H = 300;

/** In-place segmented toggle between CFR and Vineflower. */
export function DecompilerToggle({ value, onChange }: { value: DecompilerId; onChange: (d: DecompilerId) => void }) {
  return (
    <span class="rab-n-seg" role="group" aria-label="Decompiler" data-testid="decompiler-toggle">
      <button
        type="button"
        class={'rab-n-seg-btn' + (value === 'cfr' ? ' on' : '')}
        aria-pressed={value === 'cfr'}
        data-testid="decompiler-cfr"
        onClick={() => onChange('cfr')}
      >
        CFR
      </button>
      <button
        type="button"
        class={'rab-n-seg-btn' + (value === 'vineflower' ? ' on' : '')}
        aria-pressed={value === 'vineflower'}
        data-testid="decompiler-vineflower"
        onClick={() => onChange('vineflower')}
      >
        Vineflower
      </button>
    </span>
  );
}

/**
 * Virtualized decompiled Java viewer: splits lines once, tokenizes and links ONLY the ~40 visible lines on screen
 * (preventing main-thread freezes on large classes), renders line numbers, supports clickable class/annotation links
 * with rich tooltip attributes, and scrolls to/highlights a target method header line when requested.
 */
export function SourceCode({
  source, className, refs, bundleId, opKey, onOpenClass, focusLine, focusKey, maxAutoHeight, testId,
}: {
  source: string;
  className: string;
  refs?: string[];
  bundleId?: number;
  opKey?: string;
  onOpenClass: (req: OpenTabRequest) => void;
  /** 0-based line index to scroll into view and highlight (e.g. method declaration header). */
  focusLine?: number;
  focusKey?: number;
  /** When set (inline view in JavaTab), sizes the viewport up to this px height so short methods stay compact. */
  maxAutoHeight?: number;
  testId?: string;
}) {
  const { lines, inComment, maxCols } = useMemo(() => splitSourceLines(source), [source]);
  const ctx = useMemo(() => createRefContext(source, className, refs), [source, className, refs]);
  const lineCache = useMemo(() => new Map<number, SourceSpan[]>(), [source, className, refs]);
  const wrapRef = useRef<HTMLDivElement>(null);

  const getSpans = useCallback((i: number): SourceSpan[] => {
    let hit = lineCache.get(i);
    if (!hit) {
      hit = linkSourceLine(lines[i] ?? '', !!inComment[i], ctx);
      lineCache.set(i, hit);
    }
    return hit;
  }, [lines, inComment, ctx, lineCache]);

  // Position focused method declaration header near the top (with ~3 lines above so annotations remain visible)
  useEffect(() => {
    if (focusLine === undefined || focusLine < 0) return;
    const scroller = wrapRef.current?.querySelector('.rab-n-vlist') as HTMLElement | null;
    if (!scroller) return;
    const targetTop = Math.max(0, (focusLine - 3) * SOURCE_LINE_HEIGHT);
    scroller.scrollTop = targetTop;
    scroller.dispatchEvent(new Event('scroll'));
  }, [focusLine, focusKey, lines.length]);

  const digits = Math.max(2, String(lines.length).length);
  const innerMinWidth = `${Math.max(40, maxCols + digits + 6)}ch`;
  const style: Record<string, string> = { '--rab-gutter-digits': String(digits) };
  if (maxAutoHeight) {
    style.height = Math.min(maxAutoHeight, Math.max(120, lines.length * SOURCE_LINE_HEIGHT + 16)) + 'px';
  }

  return (
    <div
      ref={wrapRef}
      class={'rab-n-code-wrap rab-n-java-vcode' + (maxAutoHeight ? ' is-inline' : '')}
      style={style}
      data-testid={testId ?? 'source-code'}
      data-line-count={lines.length}
      data-focus-line={focusLine !== undefined && focusLine >= 0 ? focusLine + 1 : undefined}
    >
      <VirtualList
        count={lines.length}
        rowHeight={SOURCE_LINE_HEIGHT}
        className="rab-n-code rab-n-code-pretty rab-n-java-code-list"
        innerMinWidth={innerMinWidth}
        activeIndex={focusLine !== undefined && focusLine >= 0 ? focusLine : undefined}
        revealKey={focusKey}
        resetKey={source.length + ':' + className}
        focusable
        overscan={10}
        renderRow={(i) => {
          const spans = getSpans(i);
          const isFocus = focusLine !== undefined && i === focusLine;
          return (
            <div
              class={'rab-n-line' + (isFocus ? ' current rab-n-java-focus-line' : '')}
              data-line={i + 1}
              data-focus-line={isFocus ? 'true' : undefined}
            >
              <span class="rab-n-gutter" aria-hidden="true">{i + 1}</span>
              <span class="rab-n-code-text">
                {spans.map((s, k) => {
                  if (s.target) {
                    return (
                      <button
                        key={k}
                        type="button"
                        class={'rab-n-jc-link rab-n-jc-' + s.kind}
                        data-class-ref={s.target}
                        data-class-candidates={s.candidates.join(',')}
                        data-class-bundle={bundleId !== undefined && bundleId >= 0 ? String(bundleId) : undefined}
                        data-class-op={opKey}
                        onClick={() => onOpenClass({ target: s.target, candidates: s.candidates, fromBundle: bundleId, opKey })}
                      >
                        {s.text}
                      </button>
                    );
                  }
                  if (s.kind === 'space' || s.kind === 'name') return s.text;
                  return <span key={k} class={'rab-n-jc-' + s.kind}>{s.text}</span>;
                })}
              </span>
            </div>
          );
        }}
      />
    </div>
  );
}

export function describeSourceError(e: unknown): string {
  if (e instanceof DetailsError) {
    if (e.status === 403 && e.reason === 'decompile-disabled') return 'Decompiling is disabled on this instance (-Drest.api.browser.decompile=false).';
    if (e.status === 403) return 'Only system administrators see decompiled source.';
    if (e.reason === 'class-not-found') return 'The bytecode of this class could not be found (it may be generated at runtime or not on the classpath).';
    if (e.reason === 'invalid-class') return 'Invalid class name.';
    if (e.reason === 'session-expired') return 'Your session has expired: reload the page to log in again.';
    if (e.reason === 'not-source') return 'The server answered with something other than the decompiled source.';
    return `The server could not decompile it (${e.reason}).`;
  }
  return 'The request failed: ' + (e instanceof Error ? e.message : String(e));
}

interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

function defaultBounds(): Bounds {
  const vw = typeof document !== 'undefined' ? (document.documentElement.clientWidth || window.innerWidth) : 1280;
  const vh = typeof document !== 'undefined' ? (document.documentElement.clientHeight || window.innerHeight) : 800;
  const w = Math.min(1120, Math.max(MIN_MODAL_W, vw - 48));
  const h = Math.min(820, Math.max(MIN_MODAL_H, Math.round(vh * 0.84)));
  return {
    x: Math.max(12, Math.round((vw - w) / 2)),
    y: Math.max(12, Math.round((vh - h) / 2)),
    w,
    h,
  };
}

function clampBounds(b: Bounds): Bounds {
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;
  const w = Math.max(MIN_MODAL_W, Math.min(vw - 16, b.w));
  const h = Math.max(MIN_MODAL_H, Math.min(vh - 16, b.h));
  const x = Math.max(8, Math.min(vw - Math.min(w, 160) - 8, b.x));
  const y = Math.max(8, Math.min(vh - 48, b.y));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * Resizable, maximizable, draggable tabbed dialog for exploring decompiled Java classes.
 * Closing minimizes (hides) it while preserving every open tab; tabs can be closed individually or all at once
 * with full Undo support.
 */
export function SourceDialog({
  baseUrl, state, decompiler, onDecompiler, onSelectTab, onCloseTab, onCloseAll, onUndo, onOpenClass, onResolveTab, onMinimize,
}: {
  baseUrl: string;
  state: SourceTabsState;
  decompiler: DecompilerId;
  onDecompiler: (d: DecompilerId) => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCloseAll: () => void;
  onUndo: () => void;
  onOpenClass: (req: OpenTabRequest) => void;
  onResolveTab: (tabId: string, resolvedClass: string) => void;
  onMinimize: () => void;
}) {
  const [bounds, setBounds] = useState<Bounds>(defaultBounds);
  const [maximized, setMaximized] = useState(false);
  const [showOpenInput, setShowOpenInput] = useState(false);
  const [quickClass, setQuickClass] = useState('');
  const modalRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dragCleanup = useRef<(() => void) | undefined>(undefined);
  const minimizeRef = useRef(onMinimize);
  minimizeRef.current = onMinimize;
  const undoRef = useRef(onUndo);
  undoRef.current = onUndo;

  useEffect(() => () => dragCleanup.current?.(), []);

  // Re-clamp on window resize
  useEffect(() => {
    const onResize = () => setBounds((b) => clampBounds(b));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Escape minimizes the dialog; Ctrl+Shift+T undoes last closed tab(s)
  useEffect(() => {
    if (!state.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        minimizeRef.current();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        e.stopPropagation();
        undoRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state.open]);

  // Make the app behind the dialog inert while open (ClassHoverCard lives outside topbar/body-row so tooltips still work)
  useEffect(() => {
    if (!state.open) return;
    const app = backdropRef.current?.closest('.rab-n');
    const covered = app ? [...app.querySelectorAll<HTMLElement>(':scope > .rab-n-topbar, :scope > .rab-n-body-row')] : [];
    for (const el of covered) el.setAttribute('inert', '');
    return () => {
      for (const el of covered) el.removeAttribute('inert');
    };
  }, [state.open]);

  if (!state.open) return null;

  const active = state.tabs.find((t) => t.id === state.activeId) ?? state.tabs[0];
  const lastUndo = state.undoStack[state.undoStack.length - 1];

  const startDrag = (e: PointerEvent) => {
    if (e.button !== 0 || maximized) return;
    if ((e.target as HTMLElement | null)?.closest('button, input, a')) return;
    e.preventDefault();
    dragCleanup.current?.();
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = { ...bounds };
    let latest = origin;
    const move = (ev: PointerEvent) => {
      latest = clampBounds({ ...origin, x: origin.x + (ev.clientX - startX), y: origin.y + (ev.clientY - startY) });
      const el = modalRef.current;
      if (el) {
        el.style.left = latest.x + 'px';
        el.style.top = latest.y + 'px';
      }
    };
    const detach = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      dragCleanup.current = undefined;
    };
    const up = () => {
      detach();
      setBounds(latest);
    };
    dragCleanup.current = detach;
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  };

  const startResize = (dir: ResizeDir) => (e: PointerEvent) => {
    if (e.button !== 0 || maximized) return;
    e.preventDefault();
    e.stopPropagation();
    dragCleanup.current?.();
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = { ...bounds };
    let latest = origin;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let { x, y, w, h } = origin;
      if (dir.includes('e')) w = origin.w + dx;
      if (dir.includes('s')) h = origin.h + dy;
      if (dir.includes('w')) {
        const nw = Math.max(MIN_MODAL_W, origin.w - dx);
        x = origin.x + (origin.w - nw);
        w = nw;
      }
      if (dir.includes('n')) {
        const nh = Math.max(MIN_MODAL_H, origin.h - dy);
        y = origin.y + (origin.h - nh);
        h = nh;
      }
      latest = clampBounds({ x, y, w, h });
      const el = modalRef.current;
      if (el) {
        el.style.left = latest.x + 'px';
        el.style.top = latest.y + 'px';
        el.style.width = latest.w + 'px';
        el.style.height = latest.h + 'px';
      }
    };
    const detach = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      dragCleanup.current = undefined;
    };
    const up = () => {
      detach();
      setBounds(latest);
    };
    dragCleanup.current = detach;
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  };

  const submitQuickClass = (e: Event) => {
    e.preventDefault();
    const name = quickClass.trim();
    if (!name) return;
    onOpenClass({ target: name, candidates: [name] });
    setQuickClass('');
    setShowOpenInput(false);
  };

  const modalStyle = maximized
    ? undefined
    : { left: bounds.x + 'px', top: bounds.y + 'px', width: bounds.w + 'px', height: bounds.h + 'px' };

  return (
    <div
      ref={backdropRef}
      class="rab-n-modal-backdrop"
      data-testid="source-dialog"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onMinimize(); }}
    >
      <div
        ref={modalRef}
        class={'rab-n-modal' + (maximized ? ' is-max' : '')}
        role="dialog"
        aria-modal="true"
        aria-label="Decompiled Java classes"
        style={modalStyle}
        data-state={maximized ? 'max' : 'normal'}
      >
        <div
          class="rab-n-modal-tabs"
          role="tablist"
          aria-label="Open Java classes"
          data-testid="source-dialog-header"
          onPointerDown={startDrag}
          onDblClick={(e) => {
            if (!(e.target as HTMLElement | null)?.closest('button, input')) setMaximized((m) => !m);
          }}
        >
          <span class="rab-n-modal-grip" title="Drag to move, double-click to maximize" aria-hidden="true">⋮⋮</span>
          <div class="rab-n-modal-tabstrip">
            {state.tabs.map((t) => {
              const selected = active && t.id === active.id;
              return (
                <div
                  key={t.id}
                  class={'rab-n-modal-tab' + (selected ? ' on' : '')}
                  data-testid="source-dialog-tab"
                  data-class={t.id}
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      onCloseTab(t.id);
                    }
                  }}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={!!selected}
                    class="rab-n-modal-tab-btn"
                    title={t.id}
                    onClick={() => onSelectTab(t.id)}
                  >
                    {t.label}
                  </button>
                  <button
                    type="button"
                    class="rab-n-modal-tab-close"
                    data-testid="source-dialog-tab-close"
                    aria-label={`Close ${t.label}`}
                    title={`Close ${t.label}`}
                    onClick={(e) => { e.stopPropagation(); onCloseTab(t.id); }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              class={'rab-n-tool rab-n-modal-add' + (showOpenInput ? ' on' : '')}
              data-testid="source-dialog-add"
              title="Open any Java class by full name"
              aria-label="Open Java class by name"
              onClick={() => setShowOpenInput((v) => !v)}
            >
              +
            </button>
          </div>
          <div class="rab-n-modal-win-tools">
            <button
              type="button"
              class="rab-n-quiet"
              data-testid="source-dialog-undo"
              disabled={!lastUndo}
              title={lastUndo ? `Undo close ${lastUndo.label} (Ctrl+Shift+T)` : 'Nothing to undo'}
              onClick={onUndo}
            >
              Undo
            </button>
            <button
              type="button"
              class="rab-n-quiet"
              data-testid="source-dialog-close-all"
              disabled={state.tabs.length === 0}
              title="Close all open tabs (can be undone)"
              onClick={onCloseAll}
            >
              Close all
            </button>
            <span class="rab-n-tool-sep" aria-hidden="true" />
            <MaximizeButton
              on={maximized}
              onToggle={() => setMaximized((m) => !m)}
              what="decompiler window"
              testId="source-dialog-maximize"
            />
            <button
              type="button"
              class="rab-n-tool rab-n-modal-close"
              aria-label="Hide dialog (keeps open tabs)"
              title="Hide dialog — keeps open tabs (Esc)"
              data-testid="source-dialog-close"
              onClick={onMinimize}
            >
              —
            </button>
          </div>
        </div>
        {showOpenInput && (
          <form class="rab-n-modal-quickopen" onSubmit={submitQuickClass} data-testid="source-dialog-quickopen">
            <input
              type="text"
              class="rab-n-input"
              placeholder="Fully qualified class name (e.g. java.lang.String or com.atlassian.jira.issue.Issue)"
              value={quickClass}
              onInput={(e) => setQuickClass((e.target as HTMLInputElement).value)}
              autoFocus
              aria-label="Java class name to decompile"
            />
            <button type="submit" class="rab-n-button" disabled={!quickClass.trim()}>Decompile</button>
          </form>
        )}
        {active ? (
          <DialogTabPane
            key={active.id}
            baseUrl={baseUrl}
            tab={active}
            decompiler={decompiler}
            onDecompiler={onDecompiler}
            onOpenClass={onOpenClass}
            onResolveTab={onResolveTab}
          />
        ) : (
          <div class="rab-n-modal-empty" data-testid="source-dialog-empty">
            <p class="rab-n-subtle">No open class tabs. Click any Java type in the browser, or enter a class name below.</p>
            <form class="rab-n-modal-empty-form" onSubmit={submitQuickClass}>
              <input
                type="text"
                class="rab-n-input"
                placeholder="e.g. com.atlassian.jira.rest.v2.serverinfo.ServerInfoResource"
                value={quickClass}
                onInput={(e) => setQuickClass((e.target as HTMLInputElement).value)}
                aria-label="Java class name to decompile"
              />
              <button type="submit" class="rab-n-button" disabled={!quickClass.trim()}>Decompile</button>
              {lastUndo && (
                <button type="button" class="rab-n-button" onClick={onUndo}>
                  Undo close ({lastUndo.label})
                </button>
              )}
            </form>
          </div>
        )}
        {!maximized && (
          <>
            <div class="rab-n-resize rab-n-resize-n" onPointerDown={startResize('n')} aria-hidden="true" />
            <div class="rab-n-resize rab-n-resize-s" onPointerDown={startResize('s')} aria-hidden="true" />
            <div class="rab-n-resize rab-n-resize-e" onPointerDown={startResize('e')} aria-hidden="true" />
            <div class="rab-n-resize rab-n-resize-w" onPointerDown={startResize('w')} aria-hidden="true" />
            <div class="rab-n-resize rab-n-resize-ne" onPointerDown={startResize('ne')} aria-hidden="true" />
            <div class="rab-n-resize rab-n-resize-nw" onPointerDown={startResize('nw')} aria-hidden="true" />
            <div class="rab-n-resize rab-n-resize-sw" onPointerDown={startResize('sw')} aria-hidden="true" />
            <div class="rab-n-resize rab-n-resize-se" onPointerDown={startResize('se')} data-testid="source-dialog-resize-se" aria-hidden="true" />
          </>
        )}
      </div>
    </div>
  );
}

function DialogTabPane({
  baseUrl, tab, decompiler, onDecompiler, onOpenClass, onResolveTab,
}: {
  baseUrl: string;
  tab: SourceTab;
  decompiler: DecompilerId;
  onDecompiler: (d: DecompilerId) => void;
  onOpenClass: (req: OpenTabRequest) => void;
  onResolveTab: (tabId: string, resolvedClass: string) => void;
}) {
  const [src, setSrc] = useState<OperationSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const resolveRef = useRef(onResolveTab);
  resolveRef.current = onResolveTab;

  const query = useMemo(
    () => ({
      op: tab.opKey,
      classCandidates: tab.candidates,
      fromBundle: tab.fromBundle,
      scope: 'class' as const,
      decompiler,
    }),
    [tab.opKey, tab.candidates, tab.fromBundle, decompiler],
  );

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fetchSource(baseUrl, query).then(
      (s) => {
        if (!live) return;
        setSrc(s);
        setLoading(false);
        if (s.class && s.class !== tab.id) resolveRef.current(tab.id, s.class);
      },
      (e) => {
        if (!live) return;
        setError(describeSourceError(e));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [baseUrl, query, tab.id, attempt]);

  const focusLine = useMemo(() => {
    if (!src || !tab.focusMethod) return -1;
    const lines = src.source.split('\n');
    return findMethodHeaderLine(lines, tab.focusMethod, tab.focusParamCount);
  }, [src, tab.focusMethod, tab.focusParamCount]);

  const retry = () => {
    forgetSource(query);
    setAttempt((a) => a + 1);
  };

  const fqcn = src?.class ?? tab.id;

  return (
    <>
      <div class="rab-n-modal-bar">
        <code
          class="rab-n-modal-fqcn rab-n-jc-link"
          data-class-ref={fqcn}
          data-class-candidates={tab.candidates.join(',')}
          data-class-bundle={src?.bundleId !== undefined && src.bundleId >= 0 ? String(src.bundleId) : tab.fromBundle !== undefined && tab.fromBundle >= 0 ? String(tab.fromBundle) : undefined}
          data-class-op={tab.opKey}
          title={fqcn}
          data-testid="dialog-class-name"
        >
          {fqcn}
        </code>
        {src && (
          <span class="rab-n-subtle rab-n-modal-engine" data-testid="dialog-decompiler">
            {src.decompiler}
            {src.totalLines ? ` · ${src.totalLines.toLocaleString()} lines` : ''}
            {src.cached ? ' · cached' : src.decompileMs !== undefined ? ` · ${src.decompileMs} ms` : ''}
          </span>
        )}
        <span class="rab-n-spacer" />
        <DecompilerToggle value={decompiler} onChange={onDecompiler} />
        <CopyButton quiet label="Copy class" text={() => fqcn} />
        {src && <CopyButton quiet label="Copy source" text={() => src.source} />}
      </div>
      <div class="rab-n-modal-body" role="tabpanel" aria-label={classLabel(fqcn)}>
        {loading ? (
          <div class="rab-n-pad rab-n-subtle" role="status" data-testid="dialog-loading">
            <span class="rab-n-spinner" aria-hidden="true" /> Decompiling {classLabel(fqcn)} with {decompiler === 'vineflower' ? 'Vineflower' : 'CFR'}…
          </div>
        ) : error ? (
          <div class="rab-n-pad rab-n-java-error" role="alert" data-testid="dialog-error">
            {error}{' '}
            <button type="button" class="rab-n-quiet" onClick={retry}>Try again</button>
          </div>
        ) : src ? (
          <SourceCode
            source={src.source}
            className={src.class}
            refs={src.refs}
            bundleId={src.bundleId}
            opKey={tab.opKey}
            onOpenClass={onOpenClass}
            focusLine={focusLine}
            focusKey={(tab.focusSeq ?? 0) * 10 + (decompiler === 'vineflower' ? 2 : 1)}
            testId="dialog-source-code"
          />
        ) : null}
      </div>
    </>
  );
}
