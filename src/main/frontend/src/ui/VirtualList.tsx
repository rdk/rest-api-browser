import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

interface Props {
  count: number;
  rowHeight: number;
  renderRow: (index: number) => ComponentChildren;
  /** Scrolled into view when it changes, or when revealKey changes (the same row again, after the user scrolled away). */
  activeIndex?: number;
  revealKey?: number;
  /** A change scrolls the list back to its top (a new search). */
  resetKey?: string;
  /** A row kept rendered when the list scrolls away from it: the one with the list's tab stop, so it keeps the focus.
   * Only for short lists (not scaled): a kept row far down a scaled list would be placed past its end. */
  keepIndex?: number;
  /** A stable key per row (an operation's key): a row whose index changes keeps its element, and the focus. */
  keyOf?: (index: number) => string | number;
  /** The rows' common minimum width (a CSS length): the sideways scroll keeps the longest line's extent. */
  innerMinWidth?: string;
  /** Focusable itself (tabIndex 0), so the keyboard can scroll it: a view whose rows have nothing to focus. */
  focusable?: boolean;
  /** Scroll to activeIndex when it changes (the default); off, only revealKey does it (an index that moves because
   * rows were added above it is no reason to scroll). */
  followIndex?: boolean;
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
export function VirtualList({ count, rowHeight, renderRow, activeIndex, revealKey, resetKey, keepIndex, keyOf, innerMinWidth, focusable,
                             followIndex = true, className, overscan = 8, ariaLabel }: Props) {
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
  }, [count, rowHeight, scale]);

  const firstReset = useRef(resetKey);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || firstReset.current === resetKey) return;
    firstReset.current = resetKey;
    el.scrollTop = 0;
    setFirst(0);
  }, [resetKey]);

  useEffect(() => {
    const el = ref.current;
    // a hidden list (display: none, behind a box on the whole screen) has no height to scroll within; it scrolls
    // once it is shown again (height is a dependency)
    if (!el || !el.clientHeight || activeIndex === undefined || activeIndex < 0) return;
    // compare in virtual coordinates (the rows'), then convert back to the scaled scroll position
    const vTop = activeIndex * rowHeight;
    const vScroll = el.scrollTop * scale;
    if (vTop < vScroll) el.scrollTop = vTop / scale;
    else if (vTop + rowHeight > vScroll + el.clientHeight) el.scrollTop = (vTop + rowHeight - el.clientHeight) / scale;
    setFirst(firstFor(el.scrollTop));
  }, [followIndex ? activeIndex : -2, revealKey, rowHeight, scale, height > 0]);

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
  const row = (i: number) => (
    <div key={keyOf ? keyOf(i) : i} class="rab-n-vrow" role={ariaLabel ? 'listitem' : undefined}
         aria-setsize={ariaLabel ? count : undefined} aria-posinset={ariaLabel ? i + 1 : undefined}
         style={{ top: offset + i * rowHeight + 'px', height: rowHeight + 'px' }}>
      {renderRow(i)}
    </div>
  );
  for (let i = start; i < end; i++) rows.push(row(i));
  // the kept row stays rendered when the list scrolls away from it, so a row with the keyboard focus keeps it
  if (keepIndex !== undefined && keepIndex >= 0 && keepIndex < count && scale === 1 && (keepIndex < start || keepIndex >= end)) rows.push(row(keepIndex));
  return (
    <div
      ref={ref}
      class={'rab-n-vlist ' + (className ?? '')}
      onScroll={onScroll}
      role={ariaLabel ? 'list' : undefined}
      aria-label={ariaLabel}
      tabIndex={focusable ? 0 : undefined}
    >
      <div style={{ height: scrollHeight + 'px', position: 'relative', minWidth: innerMinWidth }} role={ariaLabel ? 'presentation' : undefined}>
        {rows}
      </div>
    </div>
  );
}
