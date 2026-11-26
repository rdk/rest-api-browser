import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import { findRows, rowEnd, wrapRows } from '../../lib/json-lines';
import { VirtualList } from '../VirtualList';
import { useFind, type Step } from './useFind';

const LINE = 20;
const GUTTER_EXTRA_PX = 18;
const NO_ROWS = wrapRows('', 1);

function useColumns(ref: { current: HTMLElement | null }, digits: number): number {
  const [cols, setCols] = useState(80);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let ch = 0;
    const measure = () => {
      const list = el.querySelector('.rab-n-vlist') as HTMLElement | null;
      const width = (list ?? el).clientWidth;
      if (!width) return;
      if (!ch) {
        const probe = document.createElement('span');
        probe.className = 'rab-n-code rab-n-code-probe';
        probe.textContent = '0'.repeat(100);
        el.appendChild(probe);
        ch = probe.getBoundingClientRect().width / 100;
        probe.remove();
        if (!ch) return;
      }
      setCols(Math.max(20, Math.floor((width - GUTTER_EXTRA_PX) / ch) - digits - 1));
    };
    measure();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(measure, 120);
    });
    observer?.observe(el);
    const list = el.querySelector('.rab-n-vlist');
    if (list) observer?.observe(list);
    return () => {
      observer?.disconnect();
      clearTimeout(timer);
    };
  }, [digits, ref]);
  return cols;
}

const RawLineRow = memo(function RawLineRow({
  lineLabel, slice, isMatch, isCurrent,
}: {
  lineLabel: string; slice: string; isMatch: boolean; isCurrent: boolean;
}) {
  return (
    <div class={'rab-n-line' + (isMatch ? ' match' : '') + (isCurrent ? ' current' : '')}>
      <span class="rab-n-gutter">{lineLabel}</span>
      <span class="rab-n-code-text rab-n-nowrap">{slice}</span>
    </div>
  );
});

/** Raw text wrapped at the pane's width so long minified payloads stay scrollable without layout stalls. */
export function TextView({ text, needle, step, onFound }: {
  text: string; needle: string; step: Step; onFound: (count: number, index: number, forNeedle: string) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const digits = useMemo(() => {
    let lines = 1;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lines++;
    return Math.max(3, String(lines).length);
  }, [text]);
  const cols = useColumns(wrap, digits);
  const rows = useMemo(() => (cols ? wrapRows(text, cols) : NO_ROWS), [text, cols]);
  const { matches, current } = useFind(needle, step, onFound, (n) => findRows(text, rows, n), rows);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const activeRow = matches.length ? matches[current] : -1;
  return (
    <div class="rab-n-code-wrap" ref={wrap} style={{ '--rab-gutter-digits': digits } as Record<string, string | number>}>
      <VirtualList
        className="rab-n-code rab-n-code-raw"
        count={rows === NO_ROWS ? 0 : rows.count}
        rowHeight={LINE}
        activeIndex={activeRow >= 0 ? activeRow : undefined}
        revealKey={step.n}
        focusable
        renderRow={(i) => {
          const first = i === 0 || rows.lines[i - 1] !== rows.lines[i];
          return (
            <RawLineRow
              lineLabel={first ? String(rows.lines[i] + 1) : ''}
              slice={text.slice(rows.starts[i], rowEnd(rows, i, text.length))}
              isMatch={matchSet.has(i)}
              isCurrent={i === activeRow}
            />
          );
        }}
      />
    </div>
  );
}
