import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fetchSource, forgetSource, peekSource, type DecompilerId, type OperationSource } from '../../core/details';
import { describeDetailsError } from '../../core/detailserror';
import {
  classLabel, extractClassOutline, findMethodHeaderLine, formatJavaSource, splitSourceLines, type OutlineItem,
} from '../../lib/java-source';
import { matchOutlineEndpoints } from '../../core/restoutline';
import type { OpenTabRequest, SourceNavEntry, SourceTab } from '../../core/sourcetabs';
import type { Module, Operation } from '../../core/types';
import { tipProps } from '../../core/uitips';
import { isInsideInert } from '../../lib/overlay';
import { CopyButton } from '../bits';
import { FindBox } from '../response/ResponseToolbar';
import type { Step } from '../response/useFind';
import { ClassOutline } from './ClassOutline';
import { DecompilerLink, DecompilerToggle, PrettyToggle } from './DecompilerControls';
import { SourceCode } from './SourceCodeView';

export interface TabMeta {
  uid: string;
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

export interface LineTracker {
  current: () => number;
  set: (line: number) => void;
  subscribe: (fn: (line: number) => void) => () => void;
}

export function createLineTracker(): LineTracker {
  let value = 1;
  const subs = new Set<(line: number) => void>();
  return {
    current: () => value,
    set: (next: number) => {
      if (next === value) return;
      value = next;
      for (const fn of subs) fn(next);
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** Single open tab body: fetches source, clears stale state across failed decompiler switches, and isolates scroll state. */
export function SourceTabPane({
  baseUrl, tab, tabButtonId, decompiler, onDecompiler, pretty, onPretty, onOpenClass, onResolveTab,
  showOutline, onToggleOutline, outlineWidth, onOutlineWidth, operations, modulesById, onMeta, lineTracker,
  canBack, canForward, onBack, onForward, onRecordLocation, onSelectOperation,
}: {
  baseUrl: string;
  tab: SourceTab;
  tabButtonId: string;
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
  onMeta: (m: TabMeta | null) => void;
  lineTracker: LineTracker;
  canBack?: boolean;
  canForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  onRecordLocation?: (entry: SourceNavEntry) => void;
  onSelectOperation?: (op: Operation) => void;
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
  const [src, setSrc] = useState<OperationSource | null>(() => peekSource(query, baseUrl));
  const [loading, setLoading] = useState(() => !peekSource(query, baseUrl));
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [jumpLine, setJumpLine] = useState<number | null>(null);
  const [jumpSeq, setJumpSeq] = useState(0);
  const [needle, setNeedle] = useState('');
  const [findStep, setFindStep] = useState<Step>({ n: 0, dir: 1 });
  const [found, setFound] = useState({ count: 0, index: 0, forNeedle: '' });
  const onFound = useCallback((count: number, index: number, forNeedle: string) => {
    setFound({ count, index, forNeedle });
  }, []);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const splitRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isInsideInert(splitRef.current)) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        if (findInputRef.current) {
          e.preventDefault();
          e.stopPropagation();
          findInputRef.current.focus();
          findInputRef.current.select();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const resolveRef = useRef(onResolveTab);
  resolveRef.current = onResolveTab;
  const metaRef = useRef(onMeta);
  metaRef.current = onMeta;

  useEffect(() => () => metaRef.current(null), []);

  useEffect(() => {
    const cached = peekSource(query, baseUrl);
    if (cached) {
      setSrc(cached);
      setLoading(false);
      setError(null);
      setJumpLine(null);
      if (cached.class && cached.class !== tab.id) resolveRef.current(tab.id, cached.class);
      return;
    }
    let live = true;
    // Clear stale source from a previous decompiler/attempt before loading so errors never show stale controls.
    setSrc(null);
    setLoading(true);
    setError(null);
    setJumpLine(null);
    metaRef.current(null);
    fetchSource(baseUrl, query).then(
      (s) => {
        if (!live) return;
        setSrc(s);
        setLoading(false);
        if (s.class && s.class !== tab.id) resolveRef.current(tab.id, s.class);
      },
      (e) => {
        if (!live) return;
        setSrc(null);
        setError(describeDetailsError(e, 'source'));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [baseUrl, query, tab.id, attempt]);

  const displaySource = useMemo(() => (src ? (pretty ? formatJavaSource(src.source) : src.source) : ''), [src, pretty]);
  const preSplit = useMemo(() => (src ? splitSourceLines(displaySource) : undefined), [src, displaySource]);
  const outline = useMemo<OutlineItem[]>(() => (preSplit ? extractClassOutline(preSplit) : []), [preSplit]);
  const endpoints = useMemo(
    () => (operations?.length && modulesById ? matchOutlineEndpoints(outline, operations, modulesById, tab.opKey, tab.focusMethod) : undefined),
    [outline, operations, modulesById, tab.opKey, tab.focusMethod],
  );
  const methodCount = useMemo(() => outline.filter((o) => o.kind !== 'type').length, [outline]);

  const initialFocusLine = useMemo(() => {
    if (!preSplit) return -1;
    if (tab.focusLine !== undefined && tab.focusLine > 0) {
      return Math.max(0, Math.min(preSplit.lines.length - 1, tab.focusLine - 1));
    }
    if (!tab.focusMethod) return -1;
    return findMethodHeaderLine(preSplit, tab.focusMethod, tab.focusParamCount);
  }, [preSplit, tab.focusLine, tab.focusMethod, tab.focusParamCount]);

  useEffect(() => {
    setJumpLine(null);
  }, [pretty, tab.focusSeq]);

  const effectiveFocusLine = jumpLine !== null ? jumpLine : initialFocusLine;

  useEffect(() => {
    lineTracker.set(effectiveFocusLine >= 0 ? effectiveFocusLine + 1 : 1);
  }, [effectiveFocusLine, src, pretty, lineTracker]);

  useEffect(() => {
    if (!src || !preSplit || loading || error) {
      metaRef.current(null);
      return;
    }
    metaRef.current({
      uid: tab.uid,
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
  }, [tab.uid, src, preSplit, displaySource.length, methodCount, loading, error]);

  const retry = () => {
    forgetSource(query, baseUrl);
    setSrc(null);
    setAttempt((a) => a + 1);
  };

  const jumpTo = useCallback((line0: number, methodName?: string, recordHistory = true) => {
    setJumpLine(line0);
    setJumpSeq((n) => n + 1);
    lineTracker.set(line0 + 1);
    if (recordHistory) onRecordLocation?.({ tabId: tab.id, focusMethod: methodName, focusLine: line0 + 1 });
  }, [lineTracker, onRecordLocation, tab.id]);

  const handleFirstLine = useCallback((ln: number) => lineTracker.set(ln), [lineTracker]);

  const fqcn = src?.class ?? tab.id;
  const activeCopy = src ? displaySource : '';

  return (
    <>
      <div class="rab-n-modal-bar">
        {(onBack || onForward) && (
          <span class="rab-n-modal-nav" data-testid="source-dialog-nav">
            <button
              type="button"
              class="rab-n-tool"
              data-testid="source-dialog-back"
              aria-label="Navigate back"
              disabled={!canBack}
              onClick={onBack}
              {...tipProps({ title: 'Navigate back', body: 'Return to the previous decompiled class or method location.', shortcut: 'Alt+Left' })}
            >
              ←
            </button>
            <button
              type="button"
              class="rab-n-tool"
              data-testid="source-dialog-forward"
              aria-label="Navigate forward"
              disabled={!canForward}
              onClick={onForward}
              {...tipProps({ title: 'Navigate forward', body: 'Go forward to the next decompiled class or method location.', shortcut: 'Alt+Right' })}
            >
              →
            </button>
          </span>
        )}
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
          class="rab-n-modal-fqcn"
          data-class-ref={fqcn}
          data-class-open="true"
          data-class-candidates={tab.candidates.join(',')}
          data-class-bundle={src?.bundleId !== undefined && src.bundleId >= 0 ? String(src.bundleId) : tab.fromBundle !== undefined && tab.fromBundle >= 0 ? String(tab.fromBundle) : undefined}
          data-class-op={tab.opKey}
          data-testid="dialog-class-name"
        >
          {fqcn}
        </code>
        <span class="rab-n-spacer" />
        {src && !error && !loading && (
          <FindBox
            initial={needle}
            reportedNeedle={found.forNeedle}
            onFind={setNeedle}
            onStep={(dir) => setFindStep((st) => ({ n: st.n + 1, dir }))}
            count={found.count}
            index={found.index}
            unit="line"
            placeholder="Find in class"
            ariaLabel="Find in class"
            inputRef={findInputRef}
            testId="source-find"
          />
        )}
        <DecompilerLink decompiler={decompiler} label={!loading && !error ? src?.decompiler : undefined} testId="dialog-decompiler" />
        <DecompilerToggle value={decompiler} onChange={onDecompiler} />
        <PrettyToggle pressed={pretty} onToggle={onPretty} />
        <CopyButton quiet label="Copy class" tip={{ title: 'Copy class name', body: `Copy ${fqcn} to your clipboard.` }} text={() => fqcn} />
        {src && !error && (
          <CopyButton quiet label="Copy source" tip={{ title: 'Copy source code', body: 'Copy the currently displayed Java source to your clipboard.' }} text={() => activeCopy} />
        )}
      </div>
      <div ref={splitRef} class="rab-n-modal-split">
        {showOutline && (
          <ClassOutline
            outline={outline}
            loading={loading}
            focusLine={effectiveFocusLine}
            lineTracker={lineTracker}
            outlineWidth={outlineWidth}
            onOutlineWidth={onOutlineWidth}
            onJump={jumpTo}
            splitRef={splitRef}
          />
        )}
        <div
          id="rab-n-source-tabpanel"
          class="rab-n-modal-body"
          role="tabpanel"
          aria-labelledby={tabButtonId}
          aria-label={classLabel(fqcn)}
        >
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
              onSelectOperation={onSelectOperation}
              focusLine={effectiveFocusLine}
              focusKey={`${tab.focusSeq ?? 0}:${jumpSeq}:${decompiler}:${pretty ? 1 : 0}`}
              preSplit={preSplit}
              endpoints={endpoints}
              decompiler={decompiler}
              pretty={pretty}
              needle={needle}
              step={findStep}
              onFound={onFound}
              onFirstLineChange={handleFirstLine}
              onSelectLine={handleFirstLine}
              testId="dialog-source-code"
            />
          ) : null}
        </div>
      </div>
    </>
  );
}
