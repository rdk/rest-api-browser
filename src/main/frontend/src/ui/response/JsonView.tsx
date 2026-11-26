import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import { find, visibleLines, type JsonLine, type LineModel } from '../../lib/json-lines';
import { indexIn } from '../../core/responsetext';
import { plural } from '../bits';
import { VirtualList } from '../VirtualList';
import { useFind, type Step } from './useFind';

const LINE = 20;
const PRETTY_LINE = 10_000;

const JsonLineRow = memo(function JsonLineRow({
  index, line, lineCount, folded, closing, isMatch, isCurrent, onToggle,
}: {
  index: number;
  line: JsonLine;
  lineCount: number;
  folded: boolean;
  closing: string;
  isMatch: boolean;
  isCurrent: boolean;
  onToggle: (i: number) => void;
}) {
  const foldable = line.foldEnd !== undefined;
  const text = line.text.trimStart();
  return (
    <div class={'rab-n-line' + (isMatch ? ' match' : '') + (isCurrent ? ' current' : '')}>
      <span class="rab-n-fold">
        {foldable && (
          <button class="rab-n-fold-btn" onClick={() => onToggle(index)} aria-label={folded ? 'Expand' : 'Collapse'} aria-expanded={!folded}>
            {folded ? '▸' : '▾'}
          </button>
        )}
      </span>
      <span class="rab-n-code-text" style={{ paddingLeft: line.depth * 2 + 'ch' }}>
        {text.length > PRETTY_LINE ? text.slice(0, PRETTY_LINE) : text}
        {text.length > PRETTY_LINE && <span class="rab-n-folded"> … {(text.length - PRETTY_LINE).toLocaleString()} more characters (see Raw or Download)</span>}
        {folded && <span class="rab-n-folded"> … {plural(lineCount, 'line')} {closing}</span>}
      </span>
    </div>
  );
});

/** Folding lossless JSON viewer over a flat line model. */
export function JsonView({ model, needle, step, onFound }: {
  model: LineModel; needle: string; step: Step; onFound: (count: number, index: number, forNeedle: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const { matches, current } = useFind(needle, step, onFound, (n) => {
    const found = find(model, n);
    if (found.length) setCollapsed((c) => (c.size ? new Set() : c));
    return found;
  });
  const visible = useMemo(() => visibleLines(model, collapsed), [model, collapsed]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const activeLine = matches.length ? matches[current] : -1;

  const toggle = useCallback((i: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }, []);

  const activeRow = activeLine >= 0 ? indexIn(visible, activeLine) : -1;
  const lastReveal = useRef('');
  useEffect(() => {
    const key = `${activeLine}:${step.n}`;
    if (key === lastReveal.current) return;
    lastReveal.current = key;
    if (activeLine >= 0 && activeRow < 0 && collapsed.size) setCollapsed(new Set());
  }, [activeLine, activeRow, collapsed.size, step.n]);

  const widest = useMemo(() => {
    let max = 0;
    for (const l of model.lines) {
      const len = l.text.trimStart().length;
      max = Math.max(max, l.depth * 2 + (len > PRETTY_LINE ? PRETTY_LINE + 60 : len));
    }
    return max;
  }, [model]);

  return (
    <div class="rab-n-code-wrap">
      <VirtualList
        className="rab-n-code rab-n-code-pretty"
        count={visible.length}
        rowHeight={LINE}
        activeIndex={activeRow >= 0 ? activeRow : undefined}
        revealKey={step.n}
        innerMinWidth={`calc(${widest}ch + 36px)`}
        focusable
        renderRow={(row) => {
          const i = visible[row];
          const line = model.lines[i];
          const foldable = line.foldEnd !== undefined;
          const folded = foldable && collapsed.has(i);
          const closing = folded ? model.lines[line.foldEnd!].text.trim() : '';
          return (
            <JsonLineRow
              index={i}
              line={line}
              lineCount={folded ? line.foldEnd! - i - 1 : 0}
              folded={folded}
              closing={closing}
              isMatch={matchSet.has(i)}
              isCurrent={i === activeLine}
              onToggle={toggle}
            />
          );
        }}
      />
    </div>
  );
}
