import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

interface Props {
  count: number;
  rowHeight: number;
  renderRow: (index: number) => ComponentChildren;
  /** Scrolled into view when it changes. */
  activeIndex?: number;
  className?: string;
  overscan?: number;
  /** Set for a semantic list (the operations); code lines leave it out. */
  ariaLabel?: string;
}

/** Browsers cap an element's height (about 17.9 million px in Firefox); stay well below. */
const MAX_HEIGHT = 8_000_000;

/**
 * A list that renders only the rows in view. Every row has the same height, so the position of any row is known
 * without measuring, and a million rows cost as much as the 30 on screen. Past MAX_HEIGHT the scrollbar maps
 * proportionally onto the rows, so the end of a 20 MB response stays reachable.
 */
export function VirtualList({ count, rowHeight, renderRow, activeIndex, className, overscan = 8, ariaLabel }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [first, setFirst] = useState(0);
  const [, setTick] = useState(0);
  const [height, setHeight] = useState(400);

  const total = count * rowHeight;
  const scrollHeight = Math.min(total, MAX_HEIGHT);
  // scrollTop -> virtual offset; 1 below the cap
  const scale = total > MAX_HEIGHT ? (total - height) / Math.max(1, scrollHeight - height) : 1;

  const firstFor = (scrollTop: number) => Math.max(0, Math.min(count - 1, Math.floor((scrollTop * scale) / rowHeight)));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);

  // a list that shrank under the current scroll position must not render empty until the next scroll event
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setFirst(firstFor(el.scrollTop));
  }, [count]);

  useEffect(() => {
    const el = ref.current;
    if (!el || activeIndex === undefined || activeIndex < 0) return;
    const top = (activeIndex * rowHeight) / scale;
    const rowPx = rowHeight / scale;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowPx > el.scrollTop + el.clientHeight) el.scrollTop = top + rowPx - el.clientHeight;
    setFirst(firstFor(el.scrollTop));
  }, [activeIndex, rowHeight]);

  const onScroll = (e: Event) => {
    const f = firstFor((e.currentTarget as HTMLDivElement).scrollTop);
    if (f !== first) setFirst(f); // only when the window of rows moves, not on every pixel
    else if (scale !== 1) setTick((t) => t + 1); // scaled: the rows' offset follows every pixel
  };

  const visible = Math.ceil(height / rowHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan);
  // rows are placed relative to the first row's position in the (possibly scaled) scroll area
  const scrollTop = ref.current?.scrollTop ?? 0;
  const offset = scrollTop * (1 - scale);
  const rows = [];
  for (let i = start; i < end; i++) {
    rows.push(
      <div key={i} class="rab-n-vrow" role={ariaLabel ? 'listitem' : undefined}
           style={{ top: offset + i * rowHeight + 'px', height: rowHeight + 'px' }}>
        {renderRow(i)}
      </div>,
    );
  }
  return (
    <div
      ref={ref}
      class={'rab-n-vlist ' + (className ?? '')}
      onScroll={onScroll}
      role={ariaLabel ? 'list' : undefined}
      aria-label={ariaLabel}
    >
      <div style={{ height: scrollHeight + 'px', position: 'relative' }} role={ariaLabel ? 'presentation' : undefined}>
        {rows}
      </div>
    </div>
  );
}
