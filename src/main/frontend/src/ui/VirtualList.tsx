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
  ariaLabel?: string;
}

/**
 * A list that renders only the rows in view. Every row has the same height, so the position of any row is known
 * without measuring, and 10,000 rows cost as much as the 30 on screen.
 */
export function VirtualList({ count, rowHeight, renderRow, activeIndex, className, overscan = 8, ariaLabel }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || activeIndex === undefined || activeIndex < 0) return;
    const top = activeIndex * rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight;
  }, [activeIndex, rowHeight]);

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + overscan);
  const rows = [];
  for (let i = first; i < last; i++) {
    rows.push(
      <div key={i} class="rab-n-vrow" style={{ top: i * rowHeight + 'px', height: rowHeight + 'px' }}>
        {renderRow(i)}
      </div>,
    );
  }
  return (
    <div
      ref={ref}
      class={'rab-n-vlist ' + (className ?? '')}
      onScroll={(e) => setScrollTop((e.currentTarget as HTMLDivElement).scrollTop)}
      role="list"
      aria-label={ariaLabel}
    >
      <div style={{ height: count * rowHeight + 'px', position: 'relative' }}>{rows}</div>
    </div>
  );
}
