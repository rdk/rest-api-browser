import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import { fetchClassInfo, fetchSource, type ClassInfo, type DecompilerId } from '../../core/details';
import { describeDetailsError } from '../../core/detailserror';
import { buildSourceArchive, buildSourceExportItem, type ExportClassMeta, type ExportErrorMeta } from '../../core/sourceexport';
import type { OpenTabRequest, SourceNavEntry, SourceTabsState } from '../../core/sourcetabs';
import { clampBounds, DEFAULT_OUTLINE_W, defaultBounds, resizeBounds, type ResizeDir, type WindowBounds } from '../../core/sourcewindow';
import type { Module, Operation } from '../../core/types';
import { acquireInert, ESCAPE_PRIORITY, isInsideInert, useEscape, usePointerDrag } from '../../lib/overlay';
import { download, useFlash } from '../bits';
import { createLineTracker, SourceTabPane, type TabMeta } from './SourceTabPane';
import { RESIZE_DIRS, SourceDialogEmpty, SourceDialogHeader, SourceDialogQuickOpen, StatusBar } from './SourceDialogChrome';

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
          <SourceDialogHeader
            tabs={state.tabs}
            active={active}
            tabstripRef={tabstripRef}
            showOpenInput={showOpenInput}
            zipping={zipping}
            zipFlash={zipFlash}
            lastUndo={lastUndo}
            maximized={maximized}
            onStartDrag={startDrag}
            onToggleMaximize={() => setMaximized((m) => !m)}
            onTabListKeyDown={onTabListKeyDown}
            onTabStripWheel={onTabStripWheel}
            onSelectTab={onSelectTab}
            onCloseTab={onCloseTab}
            onToggleOpenInput={() => setShowOpenInput((v) => !v)}
            onDownloadAllZip={downloadAllZip}
            onUndo={onUndo}
            onCloseAll={onCloseAll}
            onMinimize={onMinimize}
          />
          {showOpenInput && (
            <SourceDialogQuickOpen
              inputRef={quickInputRef}
              value={quickClass}
              onChange={setQuickClass}
              onSubmit={submitQuickClass}
            />
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
              <SourceDialogEmpty
                value={quickClass}
                lastUndo={lastUndo}
                onChange={setQuickClass}
                onSubmit={submitQuickClass}
                onUndo={onUndo}
              />
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
