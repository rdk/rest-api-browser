import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import { findEnclosingOutlineLine, type HttpMethod, type OutlineItem } from '../../lib/java-source';
import { MAX_OUTLINE_SHARE, MIN_OUTLINE_W } from '../../core/sourcewindow';
import { SplitHandle } from '../../lib/overlay';
import type { LineTracker } from './SourceTabPane';

const REST_ICON: Record<HttpMethod, { letter: string; cls: string }> = {
  GET: { letter: 'G', cls: 'rest-get' },
  POST: { letter: 'P', cls: 'rest-post' },
  PUT: { letter: 'U', cls: 'rest-put' },
  DELETE: { letter: 'D', cls: 'rest-delete' },
  PATCH: { letter: 'A', cls: 'rest-patch' },
  HEAD: { letter: 'H', cls: 'rest-other' },
  OPTIONS: { letter: 'O', cls: 'rest-other' },
};

/** Memoized class outline panel + accessible splitter; scrolling code lines never re-renders this tree. */
export const ClassOutline = memo(function ClassOutline({
  outline,
  loading,
  focusLine,
  lineTracker,
  outlineWidth,
  onOutlineWidth,
  onJump,
  splitRef,
  topSlot,
  overrideBody,
}: {
  outline: OutlineItem[];
  loading: boolean;
  focusLine: number;
  lineTracker?: LineTracker;
  outlineWidth: number;
  onOutlineWidth: (w: number) => void;
  onJump: (line0: number, methodName?: string, recordHistory?: boolean) => void;
  splitRef: { current: HTMLDivElement | null };
  topSlot?: ComponentChildren;
  overrideBody?: ComponentChildren;
}) {
  const [filter, setFilter] = useState('');
  const [liveW, setLiveW] = useState<number | null>(null);
  const [splitWidth, setSplitWidth] = useState(800);
  const [spyLine, setSpyLine] = useState<number>(() =>
    lineTracker ? findEnclosingOutlineLine(outline, lineTracker.current() - 1) : -1);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!lineTracker) {
      setSpyLine(-1);
      return;
    }
    const update = (line1Based: number) => {
      const next = findEnclosingOutlineLine(outline, line1Based - 1);
      setSpyLine((prev) => (prev === next ? prev : next));
    };
    update(lineTracker.current());
    return lineTracker.subscribe(update);
  }, [lineTracker, outline]);

  useLayoutEffect(() => {
    const el = splitRef.current;
    if (!el) return;
    const measure = () => setSplitWidth(el.clientWidth || 800);
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [splitRef]);

  useEffect(() => {
    setLiveW(null);
  }, [outlineWidth]);

  const maxOutline = Math.max(MIN_OUTLINE_W + 40, Math.round(splitWidth * MAX_OUTLINE_SHARE));
  const currentW = Math.min(maxOutline, Math.max(MIN_OUTLINE_W, liveW ?? outlineWidth));

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f
      ? outline.filter((o) =>
        o.name.toLowerCase().includes(f)
        || o.params.toLowerCase().includes(f)
        || (o.httpMethod?.toLowerCase().includes(f) ?? false)
        || (o.restPath?.toLowerCase().includes(f) ?? false))
      : outline;
  }, [outline, filter]);

  const activeLine = spyLine >= 0 ? spyLine : focusLine;
  const activeIdx = useMemo(() => filtered.findIndex((o) => o.line === activeLine), [filtered, activeLine]);

  useEffect(() => {
    if (activeLine < 0) return;
    (listRef.current?.querySelector('.rab-n-outline-item.on') as HTMLElement | null)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeLine]);

  const onListKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !filtered.length) return;
    const btns = [...(listRef.current?.querySelectorAll<HTMLElement>('.rab-n-outline-item') ?? [])];
    const focusedIdx = btns.indexOf(document.activeElement as HTMLElement);
    const cur = focusedIdx >= 0 ? focusedIdx : (activeIdx >= 0 ? activeIdx : 0);
    const nextIdx = e.key === 'ArrowDown' ? Math.min(filtered.length - 1, cur + 1)
      : e.key === 'ArrowUp' ? Math.max(0, cur - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? filtered.length - 1
      : -1;
    if (nextIdx < 0) return;
    e.preventDefault();
    const item = filtered[nextIdx];
    onJump(item.line, item.name, false);
    requestAnimationFrame(() => {
      const nextBtns = listRef.current?.querySelectorAll<HTMLElement>('.rab-n-outline-item');
      nextBtns?.[nextIdx]?.focus();
    });
  };

  return (
    <>
      <aside
        class="rab-n-modal-outline"
        style={{ width: currentW + 'px' }}
        aria-label="Class methods outline"
        data-testid="source-dialog-outline"
      >
        {topSlot}
        {overrideBody ?? (
          <>
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
                  value={filter}
                  onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && filter) {
                      e.preventDefault();
                      e.stopPropagation();
                      setFilter('');
                    }
                  }}
                />
              </div>
            )}
            <div ref={listRef} class="rab-n-modal-outline-list" onKeyDown={onListKeyDown}>
              {loading ? (
                <div class="rab-n-subtle rab-n-pad">Loading…</div>
              ) : filtered.length === 0 ? (
                <div class="rab-n-subtle rab-n-pad">{outline.length === 0 ? 'No methods found.' : 'No matches.'}</div>
              ) : (
                filtered.map((item, idx) => {
                  const isActive = activeLine === item.line;
                  const isTabStop = isActive || (activeIdx < 0 && idx === 0);
                  const rest = item.httpMethod ? REST_ICON[item.httpMethod] : undefined;
                  const restLabel = item.httpMethod
                    ? `[${item.httpMethod}${item.restPath ? ` ${item.restPath}` : ''}] `
                    : '';
                  return (
                    <button
                      key={`${item.line}:${idx}`}
                      type="button"
                      tabIndex={isTabStop ? 0 : -1}
                      aria-current={isActive ? 'location' : undefined}
                      class={'rab-n-outline-item' + (isActive ? ' on' : '')}
                      style={item.depth > 0 ? { paddingLeft: 8 + item.depth * 12 + 'px' } : undefined}
                      title={`${restLabel}${item.visibility} ${item.returns ? item.returns + ' ' : ''}${item.name}${item.params} (line ${item.line + 1})`}
                      data-testid="outline-item"
                      data-line={item.line + 1}
                      data-http-method={item.httpMethod}
                      onClick={() => onJump(item.line, item.name, true)}
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
          </>
        )}
      </aside>
      <SplitHandle
        className="rab-n-outline-split"
        orientation="vertical"
        label="Resize method outline"
        value={currentW}
        min={MIN_OUTLINE_W}
        max={maxOutline}
        step={16}
        onChange={setLiveW}
        onCommit={(w) => {
          setLiveW(null);
          onOutlineWidth(w);
        }}
        testId="source-dialog-outline-resize"
      />
    </>
  );
});
