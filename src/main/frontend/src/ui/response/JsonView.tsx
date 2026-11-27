import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal, memo } from 'preact/compat';
import { find, visibleLines, type JsonLine, type LineModel } from '../../lib/json-lines';
import { extractPrettyLineMeta, indexIn } from '../../core/responsetext';
import { acquireInert, ESCAPE_PRIORITY, useEscape } from '../../lib/overlay';
import { CopyButton, plural } from '../bits';
import { VirtualList } from '../VirtualList';
import { useFind, type Step } from './useFind';

const LINE = 20;
export const PRETTY_LINE = 10_000;
export const PRETTY_WRAP_MAX_CHARS = 200_000;
export const PRETTY_WRAP_MAX_LINES = 5_000;

function FullValueDialog({ app, lineIndex, lineText, onClose }: {
  app: HTMLElement | null; lineIndex: number; lineText: string; onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEscape(true, () => {
    onCloseRef.current();
    return true;
  }, ESCAPE_PRIORITY.MODAL);

  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const covered = app
      ? [...app.querySelectorAll<HTMLElement>(':scope > .rab-n-topbar, :scope > .rab-n-body-row')]
      : [];
    const releaseInert = acquireInert(covered);
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      releaseInert();
      if (prevFocus?.isConnected && !prevFocus.closest('[inert]')) prevFocus.focus();
    };
  }, [app]);

  const meta = useMemo(() => extractPrettyLineMeta(lineText), [lineText]);
  const modal = (
    <div
      class="rab-n-fullval-backdrop"
      data-testid="full-value-dialog"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class="rab-n-fullval-modal" role="dialog" aria-modal="true" aria-label={meta.key ? `Full JSON value: ${meta.key}` : `Full JSON line ${lineIndex + 1}`}>
        <div class="rab-n-fullval-head">
          <span class="rab-n-fullval-title">
            Line {(lineIndex + 1).toLocaleString()}
            {meta.key && <> · <code>{meta.key}</code></>}
            {' '}· {meta.text.length.toLocaleString()} characters
          </span>
          <span class="rab-n-spacer" />
          <CopyButton label="Copy line" text={() => meta.text} testId="full-value-copy" />
          <button
            ref={closeRef}
            type="button"
            class="rab-n-button"
            data-testid="full-value-close"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <textarea
          readonly
          spellcheck={false}
          class="rab-n-textarea rab-n-fullval-text"
          data-testid="full-value-textarea"
          aria-label="Full JSON line value"
          value={meta.text}
        />
      </div>
    </div>
  );
  return app ? createPortal(modal, app) : modal;
}

const JsonLineRow = memo(function JsonLineRow({
  index, line, lineCount, folded, closing, isMatch, isCurrent, onToggle, onInspectLine,
}: {
  index: number;
  line: JsonLine;
  lineCount: number;
  folded: boolean;
  closing: string;
  isMatch: boolean;
  isCurrent: boolean;
  onToggle: (i: number) => void;
  onInspectLine: (i: number) => void;
}) {
  const foldable = line.foldEnd !== undefined;
  const text = line.text.trimStart();
  const cut = text.length > PRETTY_LINE;
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
        {cut ? text.slice(0, PRETTY_LINE) : text}
        {cut && (
          <span class="rab-n-folded">
            … {(text.length - PRETTY_LINE).toLocaleString()} more characters{' '}
            <button
              type="button"
              class="rab-n-link rab-n-view-full-btn"
              data-testid="view-full-line"
              onClick={() => onInspectLine(index)}
            >
              View full
            </button>
          </span>
        )}
        {folded && <span class="rab-n-folded"> … {plural(lineCount, 'line')} {closing}</span>}
      </span>
    </div>
  );
});

/** Folding lossless JSON viewer over a flat line model. */
export function JsonView({ model, needle, step, onFound, wrap = false }: {
  model: LineModel; needle: string; step: Step; onFound: (count: number, index: number, forNeedle: string) => void; wrap?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [inspectedLine, setInspectedLine] = useState<number | null>(null);
  const wrapScrollRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!wrap || activeRow < 0) return;
    (wrapScrollRef.current?.querySelector(`[data-wrap-row="${activeRow}"]`) as HTMLElement | null)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [wrap, activeRow, step.n]);

  const widest = useMemo(() => {
    let max = 0;
    for (const l of model.lines) {
      const len = l.text.trimStart().length;
      max = Math.max(max, l.depth * 2 + (len > PRETTY_LINE ? PRETTY_LINE + 60 : len));
    }
    return max;
  }, [model]);

  const inspectedText = inspectedLine !== null ? model.lines[inspectedLine]?.text : undefined;
  const appHost = wrapScrollRef.current?.closest('.rab-n') as HTMLElement | null ?? null;

  return (
    <div ref={wrapScrollRef} class="rab-n-code-wrap">
      {wrap ? (
        <div class="rab-n-code rab-n-code-pretty is-wrap" tabIndex={0} data-testid="pretty-wrapped">
          {visible.map((i, row) => {
            const line = model.lines[i];
            const foldable = line.foldEnd !== undefined;
            const folded = foldable && collapsed.has(i);
            const closing = folded ? model.lines[line.foldEnd!].text.trim() : '';
            return (
              <div key={i} data-wrap-row={row}>
                <JsonLineRow
                  index={i}
                  line={line}
                  lineCount={folded ? line.foldEnd! - i - 1 : 0}
                  folded={folded}
                  closing={closing}
                  isMatch={matchSet.has(i)}
                  isCurrent={i === activeLine}
                  onToggle={toggle}
                  onInspectLine={setInspectedLine}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <VirtualList
          className="rab-n-code rab-n-code-pretty"
          count={visible.length}
          rowHeight={LINE}
          activeIndex={activeRow >= 0 ? activeRow : undefined}
          revealKey={step.n}
          innerMinWidth={`calc(${widest}ch + 44px)`}
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
                onInspectLine={setInspectedLine}
              />
            );
          }}
        />
      )}
      {inspectedLine !== null && inspectedText !== undefined && (
        <FullValueDialog
          app={appHost}
          lineIndex={inspectedLine}
          lineText={inspectedText}
          onClose={() => setInspectedLine(null)}
        />
      )}
    </div>
  );
}
