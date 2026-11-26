import { useCallback, useMemo, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import { createRefContext, linkSourceLine, splitSourceLines, type SourceSpan } from '../../lib/java-source';
import type { MatchedEndpoint } from '../../core/restoutline';
import { endpointHref, methodTone } from '../../core/sourcewindow';
import type { OpenTabRequest } from '../../core/sourcetabs';
import type { Operation } from '../../core/types';
import { tipProps } from '../../core/uitips';
import { useFind, type Step } from '../response/useFind';
import { VirtualList } from '../VirtualList';

export const SOURCE_LINE_HEIGHT = 20;

const NO_STEP: Step = { n: 0, dir: 1 };
const NOOP_FOUND = () => undefined;

const SourceLineRow = memo(function SourceLineRow({
  lineNo, spans, isFocus, isMatch, isCurrent, rovingSpanIndex, bundleAttr, opKey, endpoint, onSelectOperation,
}: {
  lineNo: number;
  spans: SourceSpan[];
  isFocus: boolean;
  isMatch?: boolean;
  isCurrent?: boolean;
  rovingSpanIndex: number;
  bundleAttr?: string;
  opKey?: string;
  endpoint?: MatchedEndpoint;
  onSelectOperation?: (op: Operation) => void;
}) {
  return (
    <div
      class={
        'rab-n-line'
        + (isMatch ? ' match' : '')
        + (isCurrent || isFocus ? ' current' : '')
        + (isFocus ? ' rab-n-java-focus-line' : '')
      }
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
                tabIndex={k === rovingSpanIndex ? 0 : -1}
                class={'rab-n-jc-link rab-n-jc-' + s.kind + declCls}
                data-span-idx={k}
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
            onClick={onSelectOperation ? (e) => {
              if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
                e.preventDefault();
                onSelectOperation(endpoint.op);
              }
            } : undefined}
            {...tipProps({
              title: 'Open REST endpoint',
              body: `Select ${endpoint.op.method.toUpperCase()} ${endpoint.fullPath} in REST API Browser (Ctrl+click opens in a new browser tab).`,
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
 * delegates clicks/keys through a single listener, and reveals the target method declaration with 3 context lines above.
 */
export const SourceCode = memo(function SourceCode({
  source, className, refs, bundleId, opKey, onOpenClass, onSelectOperation, focusLine, focusKey, maxAutoHeight, testId,
  onFirstLineChange, onSelectLine, preSplit, endpoints, decompiler, pretty,
  needle, step, onFound,
}: {
  source: string;
  className: string;
  refs?: string[];
  bundleId?: number;
  opKey?: string;
  onOpenClass: (req: OpenTabRequest) => void;
  onSelectOperation?: (op: Operation) => void;
  /** 0-based line index to scroll into view and highlight (e.g. method declaration header). */
  focusLine?: number;
  focusKey?: number | string;
  /** When set (inline view in JavaTab), sizes the viewport up to this px height so short methods stay compact. */
  maxAutoHeight?: number;
  testId?: string;
  onFirstLineChange?: (firstLine1Based: number) => void;
  onSelectLine?: (line1Based: number) => void;
  preSplit?: { lines: string[]; inComment: boolean[]; inTextBlock?: boolean[]; maxCols: number };
  endpoints?: Map<number, MatchedEndpoint>;
  decompiler?: string;
  pretty?: boolean;
  needle?: string;
  step?: Step;
  onFound?: (count: number, index: number, forNeedle: string) => void;
}) {
  const split = useMemo(() => preSplit ?? splitSourceLines(source), [preSplit, source]);
  const { lines, inComment, inTextBlock, maxCols } = split;
  const { matches, current } = useFind(
    needle ?? '',
    step ?? NO_STEP,
    onFound ?? NOOP_FOUND,
    (n) => {
      const low = n.toLowerCase();
      const out: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(low)) out.push(i);
      }
      return out;
    },
    lines,
  );
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const activeMatchLine = matches.length ? matches[current] : -1;
  const findSig = `${needle ?? ''}:${step?.n ?? 0}`;
  const prevTriggers = useRef<{ focusKey: number | string | undefined; findSig: string; target: 'focus' | 'find' }>({
    focusKey,
    findSig,
    target: 'focus',
  });
  if (findSig !== prevTriggers.current.findSig) {
    prevTriggers.current = { focusKey, findSig, target: activeMatchLine >= 0 ? 'find' : 'focus' };
  } else if (focusKey !== prevTriggers.current.focusKey) {
    prevTriggers.current = { focusKey, findSig, target: 'focus' };
  } else if (prevTriggers.current.target === 'find' && activeMatchLine < 0) {
    prevTriggers.current = { focusKey, findSig, target: 'focus' };
  }
  const useFindTarget = prevTriggers.current.target === 'find' && activeMatchLine >= 0;
  const activeRowIndex = useFindTarget
    ? activeMatchLine
    : (focusLine !== undefined && focusLine >= 0 ? focusLine : undefined);
  const effectiveRevealKey = useFindTarget
    ? `find:${findSig}:${activeMatchLine}`
    : `focus:${String(focusKey ?? 0)}`;
  const ctx = useMemo(() => createRefContext(source, className, refs), [source, className, refs]);
  const lineCache = useMemo(() => new Map<number, SourceSpan[]>(), [source, className, refs]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [firstVisible, setFirstVisible] = useState(0);
  const [roving, setRoving] = useState<{ line: number; span: number } | null>(null);
  const openRef = useRef(onOpenClass);
  openRef.current = onOpenClass;
  const selectLineRef = useRef(onSelectLine);
  selectLineRef.current = onSelectLine;
  const firstLineCbRef = useRef(onFirstLineChange);
  firstLineCbRef.current = onFirstLineChange;
  const handleFirstChange = useCallback((f: number) => {
    setFirstVisible(f);
    firstLineCbRef.current?.(f + 1);
  }, []);

  const getSpans = useCallback((i: number): SourceSpan[] => {
    let hit = lineCache.get(i);
    if (!hit) {
      hit = linkSourceLine(lines[i] ?? '', !!inComment[i], ctx, !!inTextBlock?.[i]);
      lineCache.set(i, hit);
    }
    return hit;
  }, [lines, inComment, inTextBlock, ctx, lineCache]);

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

  const onDelegatedFocusIn = (e: FocusEvent) => {
    const link = (e.target as HTMLElement | null)?.closest?.('[data-class-ref]') as HTMLElement | null;
    if (!link) return;
    const row = link.closest('[data-line]') as HTMLElement | null;
    const line = Number(row?.getAttribute('data-line')) - 1;
    const span = Number(link.getAttribute('data-span-idx'));
    if (line >= 0 && span >= 0) setRoving({ line, span });
  };

  const onDelegatedKeyDown = (e: KeyboardEvent) => {
    const link = (e.target as HTMLElement | null)?.closest?.('[data-class-ref]') as HTMLElement | null;
    if (!link) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      triggerLink(link);
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey
      && (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp')) {
      const all = [...(wrapRef.current?.querySelectorAll<HTMLElement>('[data-class-ref]') ?? [])];
      const idx = all.indexOf(link);
      if (idx < 0 || !all.length) return;
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
      const next = all[idx + dir];
      if (next) {
        e.preventDefault();
        next.focus();
      }
    }
  };

  let rovingLine = -1;
  let rovingSpan = -1;
  const winStart = Math.max(0, firstVisible);
  const winEnd = Math.min(lines.length, winStart + 45);
  if (
    roving
    && roving.line >= Math.max(0, winStart - 5)
    && roving.line < winEnd
    && getSpans(roving.line)[roving.span]?.target
  ) {
    rovingLine = roving.line;
    rovingSpan = roving.span;
  } else {
    for (let i = winStart; i < winEnd; i++) {
      const idx = getSpans(i).findIndex((s) => !!s.target);
      if (idx >= 0) {
        rovingLine = i;
        rovingSpan = idx;
        break;
      }
    }
  }

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
      onFocusIn={onDelegatedFocusIn}
      onKeyDown={onDelegatedKeyDown}
    >
      <VirtualList
        count={lines.length}
        rowHeight={SOURCE_LINE_HEIGHT}
        className="rab-n-code rab-n-code-pretty rab-n-java-code-list"
        innerMinWidth={innerMinWidth}
        activeIndex={activeRowIndex}
        revealKey={effectiveRevealKey}
        revealTopOffset={3}
        resetKey={`${className}:${decompiler ?? ''}:${pretty ? 1 : 0}:${source.length}`}
        focusable
        overscan={5}
        onFirstChange={handleFirstChange}
        renderRow={(i) => (
          <SourceLineRow
            lineNo={i + 1}
            spans={getSpans(i)}
            isFocus={focusLine !== undefined && i === focusLine}
            isMatch={matchSet.has(i)}
            isCurrent={i === activeMatchLine}
            rovingSpanIndex={i === rovingLine ? rovingSpan : -1}
            bundleAttr={bundleAttr}
            opKey={opKey}
            endpoint={endpoints?.get(i)}
            onSelectOperation={onSelectOperation}
          />
        )}
      />
    </div>
  );
});
