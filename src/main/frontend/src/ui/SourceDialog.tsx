import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import {
  DetailsError, fetchClassInfo, fetchSource, forgetSource, peekSource,
  type ClassInfo, type DecompilerId, type OperationSource,
} from '../core/details';
import { splitSourceLines } from '../core/javatokens';
import {
  classLabel, createRefContext, extractClassOutline, findMethodHeaderLine, linkSourceLine, matchOutlineEndpoints,
  type HttpMethod, type MatchedEndpoint, type OutlineItem, type SourceSpan,
} from '../core/javarefs';
import { formatState } from '../core/router';
import type { Module, Operation } from '../core/types';
import { buildZip, javaSourceZipPath, type ZipEntry } from '../core/zip';
import { formatJavaSource } from '../core/javaformat';
import { tipProps } from '../core/uitips';
import type { OpenTabRequest, SourceTab, SourceTabsState } from '../core/sourcetabs';
import { acquireInert, CopyButton, download, formatBytes, MaximizeButton, plural, useFlash } from './bits';
import { VirtualList } from './VirtualList';

export type { SourceTab };

const SOURCE_LINE_HEIGHT = 20;
const MIN_MODAL_W = 500;
const MIN_MODAL_H = 320;
const DEFAULT_OUTLINE_W = 240;
const MIN_OUTLINE_W = 150;
const MAX_OUTLINE_SHARE = 0.65;

const REST_ICON: Record<HttpMethod, { letter: string; cls: string }> = {
  GET: { letter: 'G', cls: 'rest-get' },
  POST: { letter: 'P', cls: 'rest-post' },
  PUT: { letter: 'U', cls: 'rest-put' },
  DELETE: { letter: 'D', cls: 'rest-delete' },
  PATCH: { letter: 'A', cls: 'rest-patch' },
  HEAD: { letter: 'H', cls: 'rest-other' },
  OPTIONS: { letter: 'O', cls: 'rest-other' },
};

const DECOMPILER_HOME: Record<DecompilerId, { url: string; fallback: string }> = {
  cfr: { url: 'https://github.com/leibnitz27/cfr', fallback: 'CFR' },
  vineflower: { url: 'https://github.com/Vineflower/vineflower', fallback: 'Vineflower' },
};

/** Decompiler name & version as a link to its GitHub repository, placed immediately left of the toggle. */
export function DecompilerLink({ decompiler, label, testId }: {
  decompiler: DecompilerId; label?: string; testId?: string;
}) {
  const info = DECOMPILER_HOME[decompiler];
  const text = label || info.fallback;
  return (
    <a
      class="rab-n-decompiler-link"
      href={info.url}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={testId}
      {...tipProps({
        title: `${text} on GitHub`,
        body: `Open the ${info.fallback} bytecode decompiler repository on GitHub in a new tab.`,
      })}
    >
      {text}
    </a>
  );
}

/** In-place segmented toggle between Vineflower and CFR. */
export function DecompilerToggle({ value, onChange }: { value: DecompilerId; onChange: (d: DecompilerId) => void }) {
  return (
    <span class="rab-n-seg" role="group" aria-label="Decompiler" data-testid="decompiler-toggle">
      <button
        type="button"
        class={'rab-n-seg-btn' + (value === 'vineflower' ? ' on' : '')}
        aria-pressed={value === 'vineflower'}
        data-testid="decompiler-vineflower"
        onClick={() => onChange('vineflower')}
        {...tipProps({
          title: 'Vineflower decompiler',
          body: 'Modern Fernflower fork with clean Java 21 syntax, records, lambdas, and annotations (default).',
        })}
      >
        Vineflower
      </button>
      <button
        type="button"
        class={'rab-n-seg-btn' + (value === 'cfr' ? ' on' : '')}
        aria-pressed={value === 'cfr'}
        data-testid="decompiler-cfr"
        onClick={() => onChange('cfr')}
        {...tipProps({
          title: 'CFR decompiler',
          body: 'Alternative Java bytecode decompiler — useful for comparing tricky bytecode, switches, or exception handling.',
        })}
      >
        CFR
      </button>
    </span>
  );
}

function methodTone(m: string): string {
  const up = m.toUpperCase();
  return up === 'GET' || up === 'POST' || up === 'PUT' || up === 'PATCH' || up === 'DELETE' ? up.toLowerCase() : 'other';
}

function endpointHref(opKey: string): string {
  const base = typeof location !== 'undefined' ? location.pathname : '/plugins/servlet/rest-api-browser';
  return base + formatState({ op: opKey, path: {}, q: {}, h: {} });
}

/**
 * Memoized single code line: skips Preact diffing on unchanged visible rows while scrolling, and uses lightweight
 * `span[role=button]` elements handled by a single delegated click/key listener on the scroll container.
 */
const SourceLineRow = memo(function SourceLineRow({ lineNo, spans, isFocus, bundleAttr, opKey, endpoint }: {
  lineNo: number;
  spans: SourceSpan[];
  isFocus: boolean;
  bundleAttr?: string;
  opKey?: string;
  endpoint?: MatchedEndpoint;
}) {
  return (
    <div
      class={'rab-n-line' + (isFocus ? ' current rab-n-java-focus-line' : '')}
      data-line={lineNo}
      data-focus-line={isFocus ? 'true' : undefined}
    >
      <span class="rab-n-gutter" aria-hidden="true">{lineNo}</span>
      <span class="rab-n-code-text">
        {spans.map((s, k) => {
          const declCls = s.decl ? ' rab-n-jc-decl-' + s.decl : '';
          if (s.target) {
            return (
              <span
                key={k}
                role="button"
                tabIndex={0}
                class={'rab-n-jc-link rab-n-jc-' + s.kind + declCls}
                data-class-ref={s.target}
                data-class-candidates={s.candidates.join(',')}
                data-class-bundle={bundleAttr}
                data-class-op={opKey}
              >
                {s.text}
              </span>
            );
          }
          if ((s.kind === 'space' || s.kind === 'name') && !s.decl) return s.text;
          const kindCls = s.kind === 'space' || s.kind === 'name' ? '' : 'rab-n-jc-' + s.kind;
          return <span key={k} class={(kindCls + declCls).trim()}>{s.text}</span>;
        })}
        {endpoint && (
          <a
            class={'rab-n-source-ep-link rab-n-method-' + methodTone(endpoint.op.method)}
            href={endpointHref(endpoint.op.key)}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="source-endpoint-link"
            data-op-key={endpoint.op.key}
            {...tipProps({
              title: 'Open REST endpoint',
              body: `Open ${endpoint.op.method.toUpperCase()} ${endpoint.fullPath} in a new REST API Browser tab to inspect parameters and send requests.`,
            })}
          >
            <span>{endpoint.op.method.toUpperCase()} {endpoint.fullPath}</span>
            <svg class="rab-n-svg" width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M9 3h4v4M13 3L7.5 8.5M11.5 9.5V13h-8.5V4.5H6.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        )}
      </span>
    </div>
  );
});

/**
 * Virtualized decompiled Java viewer: splits lines once, tokenizes and links ONLY the visible lines (cached per line),
 * delegates clicks/keys through a single listener, and smoothly scrolls to/highlights a target line when requested.
 */
export function SourceCode({
  source, className, refs, bundleId, opKey, onOpenClass, focusLine, focusKey, maxAutoHeight, testId,
  onFirstLineChange, onSelectLine, preSplit, endpoints,
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
  onFirstLineChange?: (firstLine1Based: number) => void;
  onSelectLine?: (line1Based: number) => void;
  preSplit?: { lines: string[]; inComment: boolean[]; maxCols: number };
  endpoints?: Map<number, MatchedEndpoint>;
}) {
  const split = useMemo(() => preSplit ?? splitSourceLines(source), [preSplit, source]);
  const { lines, inComment, maxCols } = split;
  const ctx = useMemo(() => createRefContext(source, className, refs), [source, className, refs]);
  const lineCache = useMemo(() => new Map<number, SourceSpan[]>(), [source, className, refs]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(onOpenClass);
  openRef.current = onOpenClass;
  const selectLineRef = useRef(onSelectLine);
  selectLineRef.current = onSelectLine;

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

  const triggerLink = (el: HTMLElement) => {
    const target = el.getAttribute('data-class-ref');
    if (!target) return;
    const rawCands = el.getAttribute('data-class-candidates');
    const candidates = rawCands ? rawCands.split(',').filter(Boolean) : [target];
    openRef.current({ target, candidates, fromBundle: bundleId, opKey });
  };

  const onDelegatedClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('a')) return;
    const link = t?.closest?.('[data-class-ref]') as HTMLElement | null;
    if (link) {
      triggerLink(link);
      return;
    }
    const row = t?.closest?.('[data-line]') as HTMLElement | null;
    if (row) {
      const ln = Number(row.getAttribute('data-line'));
      if (ln > 0) selectLineRef.current?.(ln);
    }
  };

  const onDelegatedKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const link = (e.target as HTMLElement | null)?.closest?.('[data-class-ref]') as HTMLElement | null;
    if (!link) return;
    e.preventDefault();
    triggerLink(link);
  };

  const bundleAttr = bundleId !== undefined && bundleId >= 0 ? String(bundleId) : undefined;
  const digits = Math.max(2, String(lines.length).length);
  const extraEndpointCols = useMemo(() => {
    if (!endpoints || endpoints.size === 0) return 0;
    let maxLineWithEp = maxCols;
    for (const [lineIdx, ep] of endpoints) {
      const len = (lines[lineIdx]?.length ?? 0) + ep.op.method.length + ep.fullPath.length + 10;
      if (len > maxLineWithEp) maxLineWithEp = len;
    }
    return Math.max(0, maxLineWithEp - maxCols);
  }, [endpoints, lines, maxCols]);
  const innerMinWidth = `${Math.max(40, maxCols + extraEndpointCols + digits + 6)}ch`;
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
      onClick={onDelegatedClick}
      onKeyDown={onDelegatedKeyDown}
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
        overscan={5}
        onFirstChange={onFirstLineChange ? (f) => onFirstLineChange(f + 1) : undefined}
        renderRow={(i) => (
          <SourceLineRow
            lineNo={i + 1}
            spans={getSpans(i)}
            isFocus={focusLine !== undefined && i === focusLine}
            bundleAttr={bundleAttr}
            opKey={opKey}
            endpoint={endpoints?.get(i)}
          />
        )}
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
  const w = Math.min(1180, Math.max(MIN_MODAL_W, vw - 48));
  const h = Math.min(840, Math.max(MIN_MODAL_H, Math.round(vh * 0.85)));
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

interface TabStats {
  line: number;
  totalLines: number;
  methods: number;
  refs: number;
  bytes: number;
  decompiler: string;
  decompileMs?: number;
  cached?: boolean;
  bundleId?: number;
  className: string;
}

/**
 * Resizable, maximizable, GPU-composited draggable tabbed window for exploring decompiled Java classes.
 * Features a themed header, collapsible method outline panel, status bar with live position/stats,
 * ZIP export of all open decompiled sources + metadata.json, and persistent tabs on close (minimize).
 */
export function SourceDialog({
  baseUrl, state, decompiler, onDecompiler, pretty, onPretty, outlineWidth, onOutlineWidth,
  operations, modulesById,
  onSelectTab, onCloseTab, onCloseAll, onUndo, onOpenClass, onResolveTab, onMinimize,
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
}) {
  const [bounds, setBounds] = useState<Bounds>(defaultBounds);
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
  const [quickClass, setQuickClass] = useState('');
  const [stats, setStats] = useState<TabStats | null>(null);
  const [zipping, setZipping] = useState(false);
  const [zipFlash, setZipFlash] = useState<'idle' | 'done' | 'failed'>('idle');
  const flashZip = useFlash<'done' | 'failed'>(setZipFlash);
  const modalRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dragCleanup = useRef<(() => void) | undefined>(undefined);
  const minimizeRef = useRef(onMinimize);
  minimizeRef.current = onMinimize;
  const undoRef = useRef(onUndo);
  undoRef.current = onUndo;

  useEffect(() => () => dragCleanup.current?.(), []);

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

  // Ref-counted inert on the app behind the dialog (ClassHoverCard lives outside so tooltips still work)
  useEffect(() => {
    if (!state.open) return;
    const app = backdropRef.current?.closest('.rab-n');
    const covered = app ? [...app.querySelectorAll<HTMLElement>(':scope > .rab-n-topbar, :scope > .rab-n-body-row')] : [];
    return acquireInert(covered);
  }, [state.open]);

  if (!state.open) return null;

  const active = state.tabs.find((t) => t.id === state.activeId) ?? state.tabs[0];
  const lastUndo = state.undoStack[state.undoStack.length - 1];

  // GPU-composited drag: uses transform: translate3d during movement (zero layout/repaint) and commits left/top once on drop
  const startDrag = (e: PointerEvent) => {
    if (e.button !== 0 || maximized) return;
    if ((e.target as HTMLElement | null)?.closest('button, input, a')) return;
    e.preventDefault();
    dragCleanup.current?.();
    const el = modalRef.current;
    if (!el) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = { ...bounds };
    let latest = origin;
    let raf = 0;
    let pendingDx = 0;
    let pendingDy = 0;
    el.dataset.dragging = 'true';
    const flush = () => {
      raf = 0;
      el.style.transform = `translate3d(${pendingDx}px, ${pendingDy}px, 0)`;
    };
    const move = (ev: PointerEvent) => {
      latest = clampBounds({ ...origin, x: origin.x + (ev.clientX - startX), y: origin.y + (ev.clientY - startY) });
      pendingDx = latest.x - origin.x;
      pendingDy = latest.y - origin.y;
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const detach = () => {
      if (raf) cancelAnimationFrame(raf);
      el.style.transform = '';
      delete el.dataset.dragging;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      dragCleanup.current = undefined;
    };
    const up = () => {
      detach();
      el.style.left = latest.x + 'px';
      el.style.top = latest.y + 'px';
      setBounds(latest);
    };
    dragCleanup.current = detach;
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  };

  // rAF-throttled resize with pointer-events disabled on inner code pane while resizing
  const startResize = (dir: ResizeDir) => (e: PointerEvent) => {
    if (e.button !== 0 || maximized) return;
    e.preventDefault();
    e.stopPropagation();
    dragCleanup.current?.();
    const el = modalRef.current;
    if (!el) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = { ...bounds };
    let latest = origin;
    let raf = 0;
    el.dataset.dragging = 'true';
    const flush = () => {
      raf = 0;
      el.style.left = latest.x + 'px';
      el.style.top = latest.y + 'px';
      el.style.width = latest.w + 'px';
      el.style.height = latest.h + 'px';
    };
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
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const detach = () => {
      if (raf) cancelAnimationFrame(raf);
      delete el.dataset.dragging;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      dragCleanup.current = undefined;
    };
    const up = () => {
      detach();
      flush();
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

  const downloadAllZip = async () => {
    if (zipping || !state.tabs.length) return;
    setZipping(true);
    try {
      const entries: ZipEntry[] = [];
      const seenPaths = new Set<string>();
      const metaClasses: unknown[] = [];

      await Promise.all(state.tabs.map(async (tab) => {
        const q = {
          op: tab.opKey,
          classCandidates: tab.candidates,
          fromBundle: tab.fromBundle,
          scope: 'class' as const,
          decompiler,
        };
        try {
          const src = await fetchSource(baseUrl, q);
          let file = javaSourceZipPath(src.class);
          let n = 2;
          while (seenPaths.has(file)) {
            file = file.replace(/\.java$/, `_${n++}.java`);
          }
          seenPaths.add(file);
          const formattedText = isPretty ? formatJavaSource(src.source) : src.source;
          entries.push({ name: file, data: formattedText.endsWith('\n') ? formattedText : formattedText + '\n' });

          let classInfo: ClassInfo | undefined;
          try {
            classInfo = await fetchClassInfo(baseUrl, {
              classCandidates: [src.class],
              fromBundle: src.bundleId,
              op: tab.opKey,
            });
          } catch {
            // class metadata is optional enrichment
          }
          const outline = extractClassOutline(src.source.split('\n'));
          metaClasses.push({
            class: src.class,
            file,
            decompiler: src.decompiler,
            decompilerId: src.decompilerId ?? decompiler,
            totalLines: src.totalLines ?? src.source.split('\n').length,
            bundleId: src.bundleId,
            opKey: tab.opKey,
            refs: src.refs ?? [],
            outline: outline.map((o) => ({
              kind: o.kind,
              name: o.name,
              params: o.params,
              returns: o.returns,
              ...(o.httpMethod ? { httpMethod: o.httpMethod } : {}),
              ...(o.restPath !== undefined ? { restPath: o.restPath } : {}),
              line: o.line + 1,
            })),
            info: classInfo,
          });
        } catch (err) {
          metaClasses.push({
            requested: tab.id,
            candidates: tab.candidates,
            error: describeSourceError(err),
          });
        }
      }));

      const exportedAt = new Date().toISOString();
      const metadata = {
        format: 1,
        exportedAt,
        decompiler,
        tabCount: state.tabs.length,
        classes: metaClasses,
      };
      entries.push({ name: 'metadata.json', data: JSON.stringify(metadata, null, 2) + '\n' });
      const bytes = buildZip(entries);
      const stamp = exportedAt.replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
      download(new Blob([bytes.buffer as ArrayBuffer], { type: 'application/zip' }), `decompiled-classes-${stamp}.zip`);
      flashZip('done');
    } catch {
      flashZip('failed');
    } finally {
      setZipping(false);
    }
  };

  const modalStyle = maximized
    ? undefined
    : { left: bounds.x + 'px', top: bounds.y + 'px', width: bounds.w + 'px', height: bounds.h + 'px' };

  const pct = stats && stats.totalLines > 0 ? Math.min(100, Math.round((stats.line / stats.totalLines) * 100)) : 0;

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
                    onClick={() => onSelectTab(t.id)}
                    {...tipProps({ title: t.label, body: t.id, note: 'Click to view · Middle-click to close' })}
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
          </div>
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
        <div class="rab-n-modal-main">
          {active ? (
            <DialogTabPane
              key={active.id}
              baseUrl={baseUrl}
              tab={active}
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
              onStats={setStats}
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
        <div class="rab-n-modal-status" data-testid="source-dialog-status">
          {active && stats ? (
            <>
              <span class="rab-n-modal-stat" data-testid="source-dialog-pos">
                Line {stats.line.toLocaleString()} / {stats.totalLines.toLocaleString()} ({pct}%)
              </span>
              <span class="rab-n-modal-stat-sep" aria-hidden="true">·</span>
              <span class="rab-n-modal-stat">{plural(stats.methods, 'method')}</span>
              <span class="rab-n-modal-stat-sep" aria-hidden="true">·</span>
              <span class="rab-n-modal-stat">{plural(stats.refs, 'class ref')}</span>
              <span class="rab-n-modal-stat-sep" aria-hidden="true">·</span>
              <span class="rab-n-modal-stat">{formatBytes(stats.bytes)}</span>
              {stats.bundleId !== undefined && stats.bundleId >= 0 && (
                <>
                  <span class="rab-n-modal-stat-sep" aria-hidden="true">·</span>
                  <span class="rab-n-modal-stat">OSGi bundle #{stats.bundleId}</span>
                </>
              )}
              <span class="rab-n-spacer" />
              <span class="rab-n-modal-stat">
                {stats.decompiler} ({stats.cached ? 'cached' : stats.decompileMs !== undefined ? `${stats.decompileMs} ms` : 'ready'})
              </span>
              <span class="rab-n-modal-stat-sep" aria-hidden="true">·</span>
              <span class="rab-n-modal-stat">{plural(state.tabs.length, 'tab')}</span>
            </>
          ) : (
            <>
              <span class="rab-n-modal-stat">Ready</span>
              <span class="rab-n-spacer" />
              <span class="rab-n-modal-stat">{plural(state.tabs.length, 'tab')}</span>
            </>
          )}
        </div>
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
  baseUrl, tab, decompiler, onDecompiler, pretty, onPretty, onOpenClass, onResolveTab, showOutline, onToggleOutline, outlineWidth, onOutlineWidth, operations, modulesById, onStats,
}: {
  baseUrl: string;
  tab: SourceTab;
  decompiler: DecompilerId;
  onDecompiler: (d: DecompilerId) => void;
  pretty: boolean;
  onPretty: () => void;
  onOpenClass: (req: OpenTabRequest) => void;
  onResolveTab: (tabId: string, resolvedClass: string) => void;
  showOutline: boolean;
  onToggleOutline: () => void;
  outlineWidth: number;
  onOutlineWidth: (w: number) => void;
  operations?: Operation[];
  modulesById?: Map<string, Module>;
  onStats: (s: TabStats | null) => void;
}) {
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
  const [src, setSrc] = useState<OperationSource | null>(() => peekSource(query));
  const [loading, setLoading] = useState(() => !peekSource(query));
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [jumpLine, setJumpLine] = useState<number | null>(null);
  const [jumpSeq, setJumpSeq] = useState(0);
  const [currentLine, setCurrentLine] = useState(1);
  const [outlineFilter, setOutlineFilter] = useState('');
  const splitRef = useRef<HTMLDivElement>(null);
  const outlineRef = useRef<HTMLElement>(null);
  const outlineDragStop = useRef<(() => void) | undefined>(undefined);
  const resolveRef = useRef(onResolveTab);
  resolveRef.current = onResolveTab;
  const statsRef = useRef(onStats);
  statsRef.current = onStats;

  useEffect(() => () => outlineDragStop.current?.(), []);

  useEffect(() => {
    const cached = peekSource(query);
    if (cached) {
      setSrc(cached);
      setLoading(false);
      setError(null);
      setJumpLine(null);
      if (cached.class && cached.class !== tab.id) resolveRef.current(tab.id, cached.class);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    setJumpLine(null);
    statsRef.current(null);
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

  const displaySource = useMemo(() => (src ? (pretty ? formatJavaSource(src.source) : src.source) : ''), [src, pretty]);
  const preSplit = useMemo(() => (src ? splitSourceLines(displaySource) : undefined), [src, displaySource]);
  const outline = useMemo<OutlineItem[]>(() => (preSplit ? extractClassOutline(preSplit.lines) : []), [preSplit]);
  const endpoints = useMemo(
    () => (operations?.length && modulesById ? matchOutlineEndpoints(outline, operations, modulesById, tab.opKey, tab.focusMethod) : undefined),
    [outline, operations, modulesById, tab.opKey, tab.focusMethod],
  );
  const methodCount = useMemo(() => outline.filter((o) => o.kind !== 'type').length, [outline]);

  const initialFocusLine = useMemo(() => {
    if (!preSplit || !tab.focusMethod) return -1;
    return findMethodHeaderLine(preSplit.lines, tab.focusMethod, tab.focusParamCount);
  }, [preSplit, tab.focusMethod, tab.focusParamCount]);

  useEffect(() => {
    setJumpLine(null);
  }, [pretty]);

  const effectiveFocusLine = jumpLine !== null ? jumpLine : initialFocusLine;

  useEffect(() => {
    if (effectiveFocusLine >= 0) setCurrentLine(effectiveFocusLine + 1);
    else setCurrentLine(1);
  }, [effectiveFocusLine, src, pretty]);

  useEffect(() => {
    if (!src || !preSplit) {
      statsRef.current(null);
      return;
    }
    statsRef.current({
      line: currentLine,
      totalLines: preSplit.lines.length,
      methods: methodCount,
      refs: src.refs?.length ?? 0,
      bytes: displaySource.length,
      decompiler: src.decompiler,
      decompileMs: src.decompileMs,
      cached: src.cached,
      bundleId: src.bundleId,
      className: src.class,
    });
  }, [src, preSplit, displaySource.length, currentLine, methodCount]);

  const filteredOutline = useMemo(() => {
    const f = outlineFilter.trim().toLowerCase();
    return f
      ? outline.filter((o) =>
        o.name.toLowerCase().includes(f)
        || o.params.toLowerCase().includes(f)
        || (o.httpMethod?.toLowerCase().includes(f) ?? false)
        || (o.restPath?.toLowerCase().includes(f) ?? false))
      : outline;
  }, [outline, outlineFilter]);

  const maxOutlineOf = (split: HTMLElement | null) =>
    Math.max(MIN_OUTLINE_W + 40, split ? Math.round(split.clientWidth * MAX_OUTLINE_SHARE) : 520);

  const startOutlineResize = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const split = splitRef.current;
    const aside = outlineRef.current;
    if (!split || !aside) return;
    e.preventDefault();
    outlineDragStop.current?.();
    const left = split.getBoundingClientRect().left;
    let latest = outlineWidth;
    let raf = 0;
    split.dataset.dragging = 'true';
    const flush = () => {
      raf = 0;
      aside.style.width = latest + 'px';
    };
    const move = (ev: PointerEvent) => {
      latest = Math.round(Math.min(maxOutlineOf(split), Math.max(MIN_OUTLINE_W, ev.clientX - left)));
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const detach = () => {
      if (raf) cancelAnimationFrame(raf);
      delete split.dataset.dragging;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      outlineDragStop.current = undefined;
    };
    const up = () => {
      detach();
      aside.style.width = latest + 'px';
      onOutlineWidth(latest);
    };
    outlineDragStop.current = detach;
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  };

  const onOutlineSplitKey = (e: KeyboardEvent) => {
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const next = Math.round(Math.min(
      maxOutlineOf(splitRef.current),
      Math.max(MIN_OUTLINE_W, outlineWidth + (e.key === 'ArrowRight' ? 16 : -16)),
    ));
    onOutlineWidth(next);
  };

  const retry = () => {
    forgetSource(query);
    setAttempt((a) => a + 1);
  };

  const jumpTo = (line0: number) => {
    setJumpLine(line0);
    setJumpSeq((n) => n + 1);
    setCurrentLine(line0 + 1);
  };

  const fqcn = src?.class ?? tab.id;

  return (
    <>
      <div class="rab-n-modal-bar">
        <button
          type="button"
          class={'rab-n-quiet rab-n-outline-btn' + (showOutline ? ' on' : '')}
          data-testid="source-dialog-outline-toggle"
          aria-pressed={showOutline}
          onClick={onToggleOutline}
          {...tipProps({
            title: 'Method outline',
            body: showOutline
              ? 'Hide the navigable sidebar of constructors, methods, REST endpoints, and nested types.'
              : 'Show a navigable sidebar of constructors, methods, REST endpoints, and nested types.',
          })}
        >
          <svg class="rab-n-svg" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M6 2.5v11" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          Outline{outline.length > 0 ? ` (${outline.length})` : ''}
        </button>
        <code
          class="rab-n-modal-fqcn rab-n-jc-link"
          data-class-ref={fqcn}
          data-class-candidates={tab.candidates.join(',')}
          data-class-bundle={src?.bundleId !== undefined && src.bundleId >= 0 ? String(src.bundleId) : tab.fromBundle !== undefined && tab.fromBundle >= 0 ? String(tab.fromBundle) : undefined}
          data-class-op={tab.opKey}
          data-testid="dialog-class-name"
        >
          {fqcn}
        </code>
        <span class="rab-n-spacer" />
        <DecompilerLink decompiler={decompiler} label={src?.decompiler} testId="dialog-decompiler" />
        <DecompilerToggle value={decompiler} onChange={onDecompiler} />
        <button
          type="button"
          class={'rab-n-quiet rab-n-outline-btn' + (pretty ? ' on' : '')}
          aria-pressed={pretty}
          data-testid="toggle-pretty-source"
          onClick={onPretty}
          {...tipProps({
            title: pretty ? 'Original decompiler output' : 'Pretty-reformat Java',
            body: pretty
              ? 'Showing reformatted code. Click to return to the raw decompiler output.'
              : 'Re-indent to 4 spaces, wrap long annotations and method signatures, and normalize brace spacing.',
          })}
        >
          Pretty
        </button>
        <CopyButton quiet label="Copy class" tip={{ title: 'Copy class name', body: `Copy ${fqcn} to your clipboard.` }} text={() => fqcn} />
        {src && <CopyButton quiet label="Copy source" tip={{ title: 'Copy source code', body: 'Copy the currently displayed Java source to your clipboard.' }} text={() => displaySource} />}
      </div>
      <div ref={splitRef} class="rab-n-modal-split">
        {showOutline && (
          <>
            <aside
              ref={outlineRef}
              class="rab-n-modal-outline"
              style={{ width: outlineWidth + 'px' }}
              aria-label="Class methods outline"
              data-testid="source-dialog-outline"
            >
              <div class="rab-n-modal-outline-head">
                <span>Methods</span>
                <span class="rab-n-java-nav-count">{outline.length}</span>
              </div>
              {outline.length >= 6 && (
                <div class="rab-n-modal-outline-filter">
                  <input
                    type="search"
                    class="rab-n-input"
                    placeholder="Filter methods or HTTP verb…"
                    aria-label="Filter methods"
                    value={outlineFilter}
                    onInput={(e) => setOutlineFilter((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape' && outlineFilter) {
                        e.preventDefault();
                        e.stopPropagation();
                        setOutlineFilter('');
                      }
                    }}
                  />
                </div>
              )}
              <div class="rab-n-modal-outline-list">
                {loading ? (
                  <div class="rab-n-subtle rab-n-pad">Loading…</div>
                ) : filteredOutline.length === 0 ? (
                  <div class="rab-n-subtle rab-n-pad">{outline.length === 0 ? 'No methods found.' : 'No matches.'}</div>
                ) : (
                  filteredOutline.map((item, idx) => {
                    const isActive = effectiveFocusLine === item.line;
                    const rest = item.httpMethod ? REST_ICON[item.httpMethod] : undefined;
                    const restLabel = item.httpMethod
                      ? `[${item.httpMethod}${item.restPath ? ` ${item.restPath}` : ''}] `
                      : '';
                    return (
                      <button
                        key={`${item.line}:${idx}`}
                        type="button"
                        class={'rab-n-outline-item' + (isActive ? ' on' : '')}
                        style={item.depth > 0 ? { paddingLeft: 8 + item.depth * 12 + 'px' } : undefined}
                        title={`${restLabel}${item.visibility} ${item.returns ? item.returns + ' ' : ''}${item.name}${item.params} (line ${item.line + 1})`}
                        data-testid="outline-item"
                        data-line={item.line + 1}
                        data-http-method={item.httpMethod}
                        onClick={() => jumpTo(item.line)}
                      >
                        {rest ? (
                          <span
                            class={'rab-n-outline-rest ' + rest.cls}
                            data-testid="outline-rest-badge"
                            data-http-method={item.httpMethod}
                            aria-label={item.httpMethod}
                          >
                            {rest.letter}
                          </span>
                        ) : (
                          <span class={'rab-n-outline-badge kind-' + item.kind + ' vis-' + item.visibility} aria-hidden="true">
                            {item.kind === 'ctor' ? 'C' : item.kind === 'type' ? 'T' : 'M'}
                          </span>
                        )}
                        <span class="rab-n-outline-name">
                          {item.name}
                          {item.params && <span class="rab-n-outline-params">{item.params}</span>}
                        </span>
                        <span class="rab-n-outline-ln">{item.line + 1}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </aside>
            <div
              class="rab-n-outline-split"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize method outline"
              aria-valuenow={outlineWidth}
              aria-valuemin={MIN_OUTLINE_W}
              tabIndex={0}
              data-testid="source-dialog-outline-resize"
              onPointerDown={startOutlineResize}
              onKeyDown={onOutlineSplitKey}
            />
          </>
        )}
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
              source={displaySource}
              className={src.class}
              refs={src.refs}
              bundleId={src.bundleId}
              opKey={tab.opKey}
              onOpenClass={onOpenClass}
              focusLine={effectiveFocusLine}
              focusKey={(tab.focusSeq ?? 0) * 100 + jumpSeq * 10 + (decompiler === 'vineflower' ? 4 : 2) + (pretty ? 1 : 0)}
              preSplit={preSplit}
              endpoints={endpoints}
              onFirstLineChange={setCurrentLine}
              onSelectLine={setCurrentLine}
              testId="dialog-source-code"
            />
          ) : null}
        </div>
      </div>
    </>
  );
}
