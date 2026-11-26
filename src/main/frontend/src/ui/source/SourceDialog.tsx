import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import { fetchClassInfo, fetchSource, type ClassInfo, type DecompilerId } from '../../core/details';
import { describeDetailsError } from '../../core/detailserror';
import { buildSourceArchive, buildSourceExportItem, type ExportClassMeta, type ExportErrorMeta } from '../../core/sourceexport';
import type { OpenTabRequest, SourceNavEntry, SourceTabsState } from '../../core/sourcetabs';
import { clampBounds, DEFAULT_OUTLINE_W, defaultBounds, resizeBounds, type ResizeDir, type WindowBounds } from '../../core/sourcewindow';
import type { Module, Operation } from '../../core/types';
import { tipProps } from '../../core/uitips';
import { acquireInert, ESCAPE_PRIORITY, isInsideInert, useEscape, usePointerDrag } from '../../lib/overlay';
import { download, formatBytes, MaximizeButton, plural, useFlash } from '../bits';
import { createLineTracker, SourceTabPane, type LineTracker, type TabMeta } from './SourceTabPane';

const RESIZE_DIRS: { dir: ResizeDir; testId?: string }[] = [
  { dir: 'n' }, { dir: 's' }, { dir: 'e' }, { dir: 'w' },
  { dir: 'ne' }, { dir: 'nw' }, { dir: 'sw' }, { dir: 'se', testId: 'source-dialog-resize-se' },
];

/** Isolated status bar leaf: line-number updates during scroll never re-render SourceDialog or ClassOutline. */
const StatusBar = memo(function StatusBar({
  tabCount,
  hasActive,
  meta,
  lineTracker,
}: {
  tabCount: number;
  hasActive: boolean;
  meta: TabMeta | null;
  lineTracker: LineTracker;
}) {
  const [line, setLine] = useState(() => lineTracker.current());
  useEffect(() => {
    setLine(lineTracker.current());
    return lineTracker.subscribe(setLine);
  }, [lineTracker, meta]);

  const pct = meta && meta.totalLines > 0 ? Math.min(100, Math.round((line / meta.totalLines) * 100)) : 0;

  return (
    <div class="rab-n-modal-status" data-testid="source-dialog-status">
      {hasActive && meta ? (
        <>
          <span class="rab-n-modal-stat" data-testid="source-dialog-pos">
            Line {line.toLocaleString()} / {meta.totalLines.toLocaleString()} ({pct}%)
          </span>
          <span class="rab-n-modal-stat-sep" aria-hidden="true">·</span>
          <span class="rab-n-modal-stat">{plural(meta.methods, 'method')}</span>
          <span class="rab-n-modal-stat-sep" aria-hidden="true">·</span>
          <span class="rab-n-modal-stat">{plural(meta.refs, 'class ref')}</span>
          <span class="rab-n-modal-stat-sep" aria-hidden="true">·</span>
          <span class="rab-n-modal-stat">{formatBytes(meta.bytes)}</span>
          {meta.bundleId !== undefined && meta.bundleId >= 0 && (
            <>
              <span class="rab-n-modal-stat-sep" aria-hidden="true">·</span>
              <span class="rab-n-modal-stat">OSGi bundle #{meta.bundleId}</span>
            </>
          )}
          <span class="rab-n-spacer" />
          <span class="rab-n-modal-stat">
            {meta.decompiler} ({meta.cached ? 'cached' : meta.decompileMs !== undefined ? `${meta.decompileMs} ms` : 'ready'})
          </span>
          <span class="rab-n-modal-stat-sep" aria-hidden="true">·</span>
          <span class="rab-n-modal-stat">{plural(tabCount, 'tab')}</span>
        </>
      ) : (
        <>
          <span class="rab-n-modal-stat">Ready</span>
          <span class="rab-n-spacer" />
          <span class="rab-n-modal-stat">{plural(tabCount, 'tab')}</span>
        </>
      )}
    </div>
  );
});

/**
 * Resizable, maximizable, GPU-composited draggable tabbed window for exploring decompiled Java classes.
 * Features LIFO Escape coordination, focus entry/restoration, WAI-ARIA tablist navigation, collapsible outline,
 * ZIP export with line-accurate metadata.json, and persistent tabs on minimize.
 */
export const SourceDialog = memo(function SourceDialog({
  baseUrl, state, decompiler, onDecompiler, pretty, onPretty, outlineWidth, onOutlineWidth,
  operations, modulesById,
  onSelectTab, onCloseTab, onCloseAll, onUndo, onOpenClass, onResolveTab, onMinimize,
  canBack, canForward, onBack, onForward, onRecordLocation, onSelectOperation,
}: {
  baseUrl: string;
  state: SourceTabsState;
  decompiler: DecompilerId;
  onDecompiler: (d: DecompilerId) => void;
  pretty?: boolean;
  onPretty?: () => void;
  outlineWidth?: number;
  onOutlineWidth?: (w: number) => void;
  operations?: Operation[];
  modulesById?: Map<string, Module>;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCloseAll: () => void;
  onUndo: () => void;
  onOpenClass: (req: OpenTabRequest) => void;
  onResolveTab: (tabId: string, resolvedClass: string) => void;
  onMinimize: () => void;
  canBack?: boolean;
  canForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  onRecordLocation?: (entry: SourceNavEntry) => void;
  onSelectOperation?: (op: Operation) => void;
}) {
  const [bounds, setBounds] = useState<WindowBounds>(defaultBounds);
  const [maximized, setMaximized] = useState(false);
  const [showOutline, setShowOutline] = useState(true);
  const [localPretty, setLocalPretty] = useState(false);
  const isPretty = onPretty ? !!pretty : localPretty;
  const togglePretty = onPretty ?? (() => setLocalPretty((p) => !p));
  const [localOutlineW, setLocalOutlineW] = useState(outlineWidth ?? DEFAULT_OUTLINE_W);
  const effectiveOutlineW = outlineWidth ?? localOutlineW;
  const handleOutlineWidth = useCallback((w: number) => {
    setLocalOutlineW(w);
    onOutlineWidth?.(w);
  }, [onOutlineWidth]);

  const [showOpenInput, setShowOpenInput] = useState(false);
  const showOpenInputRef = useRef(showOpenInput);
  showOpenInputRef.current = showOpenInput;
  const [quickClass, setQuickClass] = useState('');
  const [meta, setMeta] = useState<TabMeta | null>(null);
  const [zipping, setZipping] = useState(false);
  const [zipFlash, setZipFlash] = useState<'idle' | 'done' | 'failed'>('idle');
  const flashZip = useFlash<'done' | 'failed'>(setZipFlash);
  const lineTracker = useMemo(() => createLineTracker(), []);

  const modalRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const tabstripRef = useRef<HTMLDivElement>(null);
  const quickInputRef = useRef<HTMLInputElement>(null);
  const minimizeRef = useRef(onMinimize);
  minimizeRef.current = onMinimize;
  const undoRef = useRef(onUndo);
  undoRef.current = onUndo;
  const backRef = useRef(onBack);
  backRef.current = onBack;
  const forwardRef = useRef(onForward);
  forwardRef.current = onForward;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!showOpenInput) return;
    const frame = requestAnimationFrame(() => quickInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [showOpenInput]);

  const { begin } = usePointerDrag(state.open && !maximized);

  // Clamp bounds on viewport resize only while the dialog is open.
  useEffect(() => {
    if (!state.open) return;
    setBounds((b) => clampBounds(b));
    const onResize = () => setBounds((b) => clampBounds(b));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [state.open]);

  // LIFO Escape yields to clear-search inside the dialog, closes quick-open input, or minimizes the window.
  useEscape(state.open, () => {
    const focused = document.activeElement as HTMLElement | null;
    if (
      focused instanceof HTMLInputElement
      && focused.type === 'search'
      && focused.value
      && modalRef.current?.contains(focused)
    ) {
      return false;
    }
    if (showOpenInputRef.current) {
      setShowOpenInput(false);
      requestAnimationFrame(() => (modalRef.current?.querySelector('[data-testid="source-dialog-add"]') as HTMLElement | null)?.focus());
      return true;
    }
    minimizeRef.current();
    return true;
  }, ESCAPE_PRIORITY.MODAL);

  // Ctrl+Shift+T undoes last closed tab(s); Alt+Left / Alt+Right steps back/forward while dialog is open.
  useEffect(() => {
    if (!state.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (isInsideInert(modalRef.current)) return;
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        e.stopPropagation();
        undoRef.current();
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'ArrowLeft') backRef.current?.();
        else forwardRef.current?.();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state.open]);

  // Ref-counted inert on background + focus entry on open + focus restore when minimized.
  useEffect(() => {
    if (!state.open) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const app = backdropRef.current?.closest('.rab-n');
    const covered = app
      ? [...app.querySelectorAll<HTMLElement>(':scope > .rab-n-topbar, :scope > .rab-n-body-row')]
      : [];
    const releaseInert = acquireInert(covered);
    const frame = requestAnimationFrame(() => {
      const target = (modalRef.current?.querySelector('[role="tab"][aria-selected="true"], input, button') as HTMLElement | null)
        ?? modalRef.current;
      target?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      releaseInert();
      if (prevFocus?.isConnected && !prevFocus.closest('[inert]')) {
        prevFocus.focus();
      }
    };
  }, [state.open]);

  const active = state.tabs.find((t) => t.id === state.activeId) ?? state.tabs[0];

  // Keep the active tab visible inside the scrollbar-free tabstrip when tabs overflow.
  useEffect(() => {
    if (!state.open || !active) return;
    (tabstripRef.current?.querySelector('.rab-n-modal-tab.on') as HTMLElement | null)
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [state.open, active?.uid]);

  if (!state.open) return null;

  const lastUndo = state.undoStack[state.undoStack.length - 1];

  const viewport = () => ({
    vw: document.documentElement.clientWidth || window.innerWidth,
    vh: document.documentElement.clientHeight || window.innerHeight,
  });

  const startDrag = (e: PointerEvent) => {
    if (maximized) return;
    if ((e.target as HTMLElement | null)?.closest('button, input, a')) return;
    const el = modalRef.current;
    if (!el) return;
    const origin = { ...bounds };
    const startX = e.clientX;
    const startY = e.clientY;
    let latest = origin;
    begin(e, {
      start: () => {
        el.dataset.dragging = 'true';
      },
      onMove: (ev) => {
        const { vw, vh } = viewport();
        latest = clampBounds({ ...origin, x: origin.x + (ev.clientX - startX), y: origin.y + (ev.clientY - startY) }, vw, vh);
        el.style.transform = `translate3d(${latest.x - origin.x}px, ${latest.y - origin.y}px, 0)`;
      },
      onEnd: (_ev, _s, moved) => {
        el.style.transform = '';
        delete el.dataset.dragging;
        if (moved) {
          el.style.left = latest.x + 'px';
          el.style.top = latest.y + 'px';
          setBounds(latest);
        }
      },
    });
  };

  const startResize = (dir: ResizeDir) => (e: PointerEvent) => {
    if (maximized) return;
    e.stopPropagation();
    const el = modalRef.current;
    if (!el) return;
    const origin = { ...bounds };
    const startX = e.clientX;
    const startY = e.clientY;
    let latest = origin;
    begin(e, {
      start: () => {
        el.dataset.dragging = 'true';
      },
      onMove: (ev) => {
        const { vw, vh } = viewport();
        latest = resizeBounds(origin, dir, ev.clientX - startX, ev.clientY - startY, vw, vh);
        el.style.left = latest.x + 'px';
        el.style.top = latest.y + 'px';
        el.style.width = latest.w + 'px';
        el.style.height = latest.h + 'px';
      },
      onEnd: (_ev, _s, moved) => {
        delete el.dataset.dragging;
        if (moved) {
          el.style.left = latest.x + 'px';
          el.style.top = latest.y + 'px';
          el.style.width = latest.w + 'px';
          el.style.height = latest.h + 'px';
          setBounds(latest);
        }
      },
    });
  };

  const submitQuickClass = (e: Event) => {
    e.preventDefault();
    const raw = quickClass.trim();
    if (!raw) return;
    const lineMatch = /^(.+?):(\d+)$/.exec(raw);
    const name = lineMatch ? lineMatch[1].trim() : raw;
    const focusLine = lineMatch ? Number(lineMatch[2]) : undefined;
    if (!name) return;
    onOpenClass({ target: name, candidates: [name], focusLine });
    setQuickClass('');
    setShowOpenInput(false);
  };

  const downloadAllZip = async () => {
    if (zipping || !state.tabs.length) return;
    setZipping(true);
    try {
      const seenPaths = new Set<string>();
      const results = await Promise.all(state.tabs.map(async (tab) => {
        const q = {
          op: tab.opKey,
          classCandidates: tab.candidates,
          fromBundle: tab.fromBundle,
          scope: 'class' as const,
          decompiler,
        };
        try {
          const src = await fetchSource(baseUrl, q);
          let classInfo: ClassInfo | undefined;
          try {
            classInfo = await fetchClassInfo(baseUrl, {
              classCandidates: [src.class],
              fromBundle: src.bundleId,
              op: tab.opKey,
            });
          } catch {
            // Optional metadata enrichment
          }
          return { ok: true as const, tab, src, classInfo };
        } catch (err) {
          return {
            ok: false as const,
            errorMeta: { requested: tab.id, candidates: tab.candidates, error: describeDetailsError(err, 'source') } satisfies ExportErrorMeta,
          };
        }
      }));

      const entries = [];
      const metaClasses: (ExportClassMeta | ExportErrorMeta)[] = [];
      for (const r of results) {
        if (!r.ok) {
          metaClasses.push(r.errorMeta);
        } else {
          const item = buildSourceExportItem(r.tab, r.src, { pretty: isPretty, decompiler, classInfo: r.classInfo, seenPaths });
          entries.push(item.entry);
          metaClasses.push(item.meta);
        }
      }

      const { bytes, filename } = buildSourceArchive(entries, metaClasses, { decompiler, tabCount: state.tabs.length });
      if (!mountedRef.current) return;
      download(new Blob([bytes.buffer as ArrayBuffer], { type: 'application/zip' }), filename);
      flashZip('done');
    } catch {
      if (mountedRef.current) flashZip('failed');
    } finally {
      if (mountedRef.current) setZipping(false);
    }
  };

  const onTabListKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !state.tabs.length) return;
    const at = active ? state.tabs.findIndex((t) => t.id === active.id) : 0;
    const nextIdx = e.key === 'ArrowRight' ? (at + 1) % state.tabs.length
      : e.key === 'ArrowLeft' ? (at + state.tabs.length - 1) % state.tabs.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? state.tabs.length - 1
      : -1;
    if (nextIdx < 0) return;
    e.preventDefault();
    const target = state.tabs[nextIdx];
    onSelectTab(target.id);
    const strip = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => (strip.querySelector(`#rab-n-src-tab-${CSS.escape(target.uid)}`) as HTMLElement | null)?.focus());
  };

  const onTabStripWheel = (e: WheelEvent) => {
    const strip = tabstripRef.current;
    if (!strip || strip.scrollWidth <= strip.clientWidth) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      strip.scrollLeft += e.deltaY;
    }
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
        tabIndex={-1}
        style={modalStyle}
        data-state={maximized ? 'max' : 'normal'}
      >
        <div class="rab-n-modal-frame">
          <div
            class="rab-n-modal-tabs"
            data-testid="source-dialog-header"
            onPointerDown={startDrag}
            onDblClick={(e) => {
              if (!(e.target as HTMLElement | null)?.closest('button, input')) setMaximized((m) => !m);
            }}
          >
            <span class="rab-n-modal-grip" title="Drag to move, double-click to maximize" aria-hidden="true">⋮⋮</span>
            <div
              ref={tabstripRef}
              class="rab-n-modal-tabstrip"
              role="tablist"
              aria-label="Open Java classes"
              onKeyDown={onTabListKeyDown}
              onWheel={onTabStripWheel}
            >
              {state.tabs.map((t) => {
                const selected = active && t.id === active.id;
                return (
                  <div
                    key={t.uid}
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
                      id={`rab-n-src-tab-${t.uid}`}
                      role="tab"
                      aria-selected={!!selected}
                      aria-controls="rab-n-source-tabpanel"
                      tabIndex={selected ? 0 : -1}
                      class="rab-n-modal-tab-btn"
                      data-class-ref={t.id}
                      data-class-open="true"
                      data-class-candidates={t.candidates.join(',')}
                      data-class-bundle={t.fromBundle !== undefined && t.fromBundle >= 0 ? String(t.fromBundle) : undefined}
                      data-class-op={t.opKey}
                      onClick={() => onSelectTab(t.id)}
                    >
                      {t.label}
                    </button>
                    <button
                      type="button"
                      class="rab-n-modal-tab-close"
                      data-testid="source-dialog-tab-close"
                      aria-label={`Close ${t.label}`}
                      {...tipProps({ title: `Close ${t.label}`, body: 'Close this class tab (can be reopened with Undo).' })}
                      onClick={(e) => { e.stopPropagation(); onCloseTab(t.id); }}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              class={'rab-n-modal-hbtn rab-n-modal-add' + (showOpenInput ? ' on' : '')}
              data-testid="source-dialog-add"
              aria-label="Open Java class by name"
              onClick={() => setShowOpenInput((v) => !v)}
              {...tipProps({ title: 'Open class by name', body: 'Decompile any Java class by entering its fully qualified class name.' })}
            >
              +
            </button>
            <div class="rab-n-modal-win-tools">
              <button
                type="button"
                class={'rab-n-modal-hbtn' + (zipFlash === 'done' ? ' done' : zipFlash === 'failed' ? ' failed' : '')}
                data-testid="source-dialog-download-zip"
                disabled={state.tabs.length === 0 || zipping}
                onClick={downloadAllZip}
                {...tipProps({
                  title: 'Download all as ZIP',
                  body: `Export ${plural(state.tabs.length, 'open class', 'open classes')} as .java source files plus a metadata.json manifest.`,
                })}
              >
                <svg class="rab-n-svg" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 2.5v7.5M5 7.2L8 10.2l3-3M2.8 12.8h10.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {zipping ? 'Zipping…' : zipFlash === 'done' ? 'Saved' : zipFlash === 'failed' ? 'Failed' : 'ZIP'}
              </button>
              <button
                type="button"
                class="rab-n-modal-hbtn"
                data-testid="source-dialog-undo"
                disabled={!lastUndo}
                onClick={onUndo}
                {...tipProps(lastUndo
                  ? { title: 'Undo close', body: `Reopen ${lastUndo.label}.`, shortcut: 'Ctrl+Shift+T' }
                  : { title: 'Undo close', body: 'No recently closed tabs to restore.' })}
              >
                Undo
              </button>
              <button
                type="button"
                class="rab-n-modal-hbtn"
                data-testid="source-dialog-close-all"
                disabled={state.tabs.length === 0}
                onClick={onCloseAll}
                {...tipProps({ title: 'Close all tabs', body: 'Close every open class tab (can be restored with Undo).' })}
              >
                Close all
              </button>
              <span class="rab-n-modal-hsep" aria-hidden="true" />
              <MaximizeButton
                on={maximized}
                onToggle={() => setMaximized((m) => !m)}
                what="decompiler window"
                testId="source-dialog-maximize"
                shortcut=""
                tip={maximized
                  ? { title: 'Restore decompiler window', body: 'Return the decompiler window to its floating size (Esc minimizes).' }
                  : { title: 'Maximize decompiler window', body: 'Expand the decompiler window to fill the viewport.' }}
              />
              <button
                type="button"
                class="rab-n-tool rab-n-modal-close"
                aria-label="Hide dialog (keeps open tabs)"
                data-testid="source-dialog-close"
                onClick={onMinimize}
                {...tipProps({ title: 'Hide window', body: 'Minimize the decompiler window while keeping all open tabs in the top bar\'s Classes button.', shortcut: 'Esc' })}
              >
                —
              </button>
            </div>
          </div>
          {showOpenInput && (
            <form class="rab-n-modal-quickopen" onSubmit={submitQuickClass} data-testid="source-dialog-quickopen">
              <input
                ref={quickInputRef}
                type="text"
                class="rab-n-input"
                placeholder="Fully qualified class name or Class:line (e.g. java.lang.String or com.atlassian.jira.issue.Issue:42)"
                value={quickClass}
                onInput={(e) => setQuickClass((e.target as HTMLInputElement).value)}
                aria-label="Java class name to decompile"
              />
              <button type="submit" class="rab-n-button" disabled={!quickClass.trim()}>Decompile</button>
            </form>
          )}
          <div class="rab-n-modal-main">
            {active ? (
              <SourceTabPane
                key={active.uid}
                baseUrl={baseUrl}
                tab={active}
                tabButtonId={`rab-n-src-tab-${active.uid}`}
                decompiler={decompiler}
                onDecompiler={onDecompiler}
                pretty={isPretty}
                onPretty={togglePretty}
                onOpenClass={onOpenClass}
                onResolveTab={onResolveTab}
                showOutline={showOutline}
                onToggleOutline={() => setShowOutline((v) => !v)}
                outlineWidth={effectiveOutlineW}
                onOutlineWidth={handleOutlineWidth}
                operations={operations}
                modulesById={modulesById}
                onMeta={setMeta}
                lineTracker={lineTracker}
                canBack={canBack}
                canForward={canForward}
                onBack={onBack}
                onForward={onForward}
                onRecordLocation={onRecordLocation}
                onSelectOperation={onSelectOperation}
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
          </div>
          <StatusBar
            tabCount={state.tabs.length}
            hasActive={!!active}
            meta={active && meta?.uid === active.uid ? meta : null}
            lineTracker={lineTracker}
          />
        </div>
        {!maximized && RESIZE_DIRS.map((r) => (
          <div
            key={r.dir}
            class={'rab-n-resize rab-n-resize-' + r.dir}
            onPointerDown={startResize(r.dir)}
            data-testid={r.testId}
            aria-hidden="true"
          />
        ))}
      </div>
    </div>
  );
});
