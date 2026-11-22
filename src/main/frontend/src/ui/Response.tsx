import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { downloadBlob, type RunResult } from './runner';
import { buildLines, find, visibleLines, type LineModel } from '../core/jsonlines';
import { VirtualList } from './VirtualList';
import { Tabs, download, formatBytes } from './bits';

const LINE = 20;
/** Longer lines are split into rows (raw text) or cut (JSON): one DOM text node of megabytes freezes the tab. */
const MAX_LINE = 2000;

type View = 'pretty' | 'raw' | 'headers';

let resultSeq = 0;
const resultIds = new WeakMap<RunResult, number>();
const idOf = (r: RunResult) => {
  let id = resultIds.get(r);
  if (id === undefined) resultIds.set(r, (id = ++resultSeq));
  return id;
};

export function ResponseView({ result, running, onCancel }: {
  result: RunResult | null; running: boolean; onCancel: () => void;
}) {
  const [view, setView] = useState<View>('pretty');
  // parsed once per response, kept across tab switches
  const model = useMemo(
    () => (result && result.kind === 'json' && !result.truncated && result.text ? buildLines(result.text) : null),
    [result],
  );
  if (running) {
    return (
      <div class="rab-n-response rab-n-response-state" data-testid="response-running">
        <div class="rab-n-response-state-inner">
          <span class="rab-n-spinner" /> Sending… <button class="rab-n-link" onClick={onCancel}>Cancel (Esc)</button>
        </div>
      </div>
    );
  }
  if (!result) {
    return (
      <div class="rab-n-response rab-n-response-state" data-testid="response-idle">
        <div class="rab-n-response-state-inner">
          <svg class="rab-n-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2.5 4.5h11v7h-11v-7zM5 8h6M5 6.3h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>The response shows here once you send the request (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>).</span>
        </div>
      </div>
    );
  }
  if (result.error) {
    return (
      <div class="rab-n-response rab-n-response-state" data-testid="response-error">
        <div class="rab-n-response-state-inner is-error">
          <svg class="rab-n-svg rab-n-error" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 5v3.5M8 10.7v.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <span class="rab-n-error">{result.error === 'aborted' ? 'The request was cancelled.' : 'The request failed: ' + result.error}</span>
        </div>
      </div>
    );
  }
  const statusClass = result.status >= 500 ? 'err' : result.status >= 400 ? 'warn' : result.status >= 300 ? 'info' : 'ok';
  const fileName = 'response' + (result.kind === 'json' ? '.json' : result.kind === 'xml' ? '.xml' : result.kind === 'html' ? '.html' : '');
  const id = idOf(result);
  return (
    <div class="rab-n-response" data-testid="response">
      {result.sessionExpired && (
        <div class="rab-n-banner" data-testid="session-expired">
          Your session has expired, so the product answered with its login page.{' '}
          <button class="rab-n-link" onClick={() => location.reload()}>Reload to log in again</button>
        </div>
      )}
      <div class={'rab-n-statusline is-' + statusClass}>
        <span class={'rab-n-status-code ' + statusClass} data-testid="response-status">{result.status} {result.statusText}</span>
        <span class="rab-n-metric">{Math.round(result.durationMs)} ms</span>
        <span class="rab-n-metric">{formatBytes(result.size)}{result.truncated ? ' (truncated)' : ''}</span>
        <span class="rab-n-subtle rab-n-status-url">{result.method} {result.url}</span>
        <span class="rab-n-spacer" />
        {result.size > 0 && (
          <button
            class="rab-n-button"
            onClick={() => {
              const blob = downloadBlob(result);
              if (blob) download(blob, fileName);
            }}
          >
            <svg class="rab-n-svg" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 2.5v7.5M5 7.5L8 10.5l3-3M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Download
          </button>
        )}
      </div>
      <Tabs<View>
        value={view}
        onChange={setView}
        tabs={[
          { id: 'pretty', label: 'Pretty' },
          { id: 'raw', label: 'Raw' },
          { id: 'headers', label: `Headers (${(result.requestHeaders?.length ?? 0) + result.headers.length})` },
        ]}
      />
      {result.truncated && (
        <div class="rab-n-banner">The response is larger than the limit; only its start was read. Download saves that part.</div>
      )}
      {view === 'headers' ? (
        <div class="rab-n-headers" data-testid="response-headers">
          <div class="rab-n-headers-title" data-testid="request-headers-title">
            Request <span class="rab-n-headers-count">{result.requestHeaders?.length ?? 0}</span>
            <span class="rab-n-headers-note">set by the browser too: cookies, User-Agent, Origin…</span>
          </div>
          {(result.requestHeaders ?? []).map(([k, v], i) => (
            <div class="rab-n-header-row" key={'q' + i} data-testid="request-header"><span class="rab-n-header-name">{k}:</span> {v}</div>
          ))}
          <div class="rab-n-headers-title">
            Response <span class="rab-n-headers-count">{result.headers.length}</span>
          </div>
          {result.headers.map(([k, v], i) => (
            <div class="rab-n-header-row" key={'r' + i}><span class="rab-n-header-name">{k}:</span> {v}</div>
          ))}
        </div>
      ) : result.kind === 'binary' ? (
        <div class="rab-n-response-state rab-n-subtle">Binary content ({result.contentType || 'no content type'}). Use Download.</div>
      ) : result.kind === 'empty' ? (
        <div class="rab-n-response-state rab-n-subtle">No content.</div>
      ) : view === 'pretty' && model ? (
        <JsonView key={'json' + id} model={model} />
      ) : (
        <>
          {result.kind === 'html' && view === 'pretty' && (
            <div class="rab-n-banner">The server answered with an HTML page; its source is shown.</div>
          )}
          <TextView key={'text' + id} text={result.text ?? ''} />
        </>
      )}
    </div>
  );
}

/** Find as you type, 150 ms after the last key; Enter and Shift+Enter step through the matches. */
function FindBox({ onFind, onStep, count, index }: {
  onFind: (needle: string) => void; onStep: (step: number) => void; count: number; index: number;
}) {
  const [needle, setNeedle] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div class="rab-n-find">
      <div class="rab-n-find-wrap">
        <svg class="rab-n-svg rab-n-find-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5L13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          placeholder="Find in response"
          value={needle}
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            setNeedle(v);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              timer.current = undefined;
              onFind(v);
            }, 150);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            if (timer.current !== undefined) {
              // typed less than 150 ms ago: search now instead of stepping through the old matches
              clearTimeout(timer.current);
              timer.current = undefined;
              onFind(needle);
            } else {
              onStep(e.shiftKey ? -1 : 1);
            }
          }}
          aria-label="Find in response"
        />
      </div>
      {needle && <span class="rab-n-subtle rab-n-find-count">{count ? `${index + 1} of ${count}` : 'no match'}</span>}
    </div>
  );
}

/** Index of value in a sorted array, or -1. */
function indexIn(sorted: number[], value: number): number {
  let lo = 0, hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] === value) return mid;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** A folding JSON view over the flat line model: only visible lines are rendered. */
function JsonView({ model }: { model: LineModel }) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [matches, setMatches] = useState<number[]>([]);
  const [current, setCurrent] = useState(0);
  const visible = useMemo(() => visibleLines(model, collapsed), [model, collapsed]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const activeLine = matches.length ? matches[current] : -1;
  const onFind = (needle: string) => {
    const found = needle ? find(model, needle) : [];
    if (found.length && collapsed.size) setCollapsed(new Set()); // a match may sit inside a folded block
    setMatches(found);
    setCurrent(0);
  };
  const onStep = (step: number) => {
    if (matches.length) setCurrent((c) => (c + step + matches.length) % matches.length);
  };
  const toggle = (i: number) => {
    const next = new Set(collapsed);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setCollapsed(next);
  };
  const activeRow = activeLine >= 0 ? indexIn(visible, activeLine) : -1;
  return (
    <div class="rab-n-code-wrap">
      <FindBox onFind={onFind} onStep={onStep} count={matches.length} index={current} />
      <VirtualList
        className="rab-n-code rab-n-code-pretty"
        count={visible.length}
        rowHeight={LINE}
        activeIndex={activeRow >= 0 ? activeRow : undefined}
        renderRow={(row) => {
          const i = visible[row];
          const line = model.lines[i];
          const foldable = line.foldEnd !== undefined;
          const folded = foldable && collapsed.has(i);
          const closing = folded ? model.lines[line.foldEnd!].text.trim() : '';
          const text = line.text.trimStart();
          return (
            <div class={'rab-n-line' + (matchSet.has(i) ? ' match' : '') + (i === activeLine ? ' current' : '')}>
              <span class="rab-n-fold">
                {foldable && (
                  <button class="rab-n-fold-btn" onClick={() => toggle(i)} aria-label={folded ? 'Expand' : 'Collapse'}>
                    {folded ? '▸' : '▾'}
                  </button>
                )}
              </span>
              <span class="rab-n-code-text" style={{ paddingLeft: line.depth * 2 + 'ch' }}>
                {text.length > MAX_LINE ? text.slice(0, MAX_LINE) : text}
                {text.length > MAX_LINE && <span class="rab-n-folded"> … {(text.length - MAX_LINE).toLocaleString()} more characters (see Raw or Download)</span>}
                {folded && <span class="rab-n-folded"> … {line.foldEnd! - i - 1} lines {closing}</span>}
              </span>
            </div>
          );
        }}
      />
    </div>
  );
}

/** Raw text, split into rows of at most MAX_LINE characters (minified JSON is one line of megabytes). */
function TextView({ text }: { text: string }) {
  const rows = useMemo(() => {
    const out: { line: number; text: string; cont: boolean }[] = [];
    let line = 0, start = 0;
    while (start <= text.length) {
      let end = text.indexOf('\n', start);
      if (end < 0) end = text.length;
      for (let s = start; s < end || s === start; s += MAX_LINE) {
        out.push({ line, text: text.slice(s, Math.min(end, s + MAX_LINE)), cont: s > start });
        if (end - s <= MAX_LINE) break;
      }
      line++;
      start = end + 1;
    }
    return out;
  }, [text]);
  const lower = useRef<string[] | null>(null);
  const [matches, setMatches] = useState<number[]>([]);
  const [current, setCurrent] = useState(0);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const onFind = (needle: string) => {
    const n = needle.toLowerCase();
    const found: number[] = [];
    if (n) {
      if (!lower.current) lower.current = rows.map((r) => r.text.toLowerCase());
      const l = lower.current;
      for (let i = 0; i < l.length; i++) if (l[i].includes(n)) found.push(i);
    }
    setMatches(found);
    setCurrent(0);
  };
  const onStep = (step: number) => {
    if (matches.length) setCurrent((c) => (c + step + matches.length) % matches.length);
  };
  const activeRow = matches.length ? matches[current] : -1;
  return (
    <div class="rab-n-code-wrap">
      <FindBox onFind={onFind} onStep={onStep} count={matches.length} index={current} />
      <VirtualList
        className="rab-n-code"
        count={rows.length}
        rowHeight={LINE}
        activeIndex={activeRow >= 0 ? activeRow : undefined}
        renderRow={(i) => (
          <div class={'rab-n-line' + (matchSet.has(i) ? ' match' : '') + (i === activeRow ? ' current' : '')}>
            <span class="rab-n-gutter">{rows[i].cont ? '' : rows[i].line + 1}</span>
            <span class="rab-n-code-text rab-n-nowrap">{rows[i].text}</span>
          </div>
        )}
      />
    </div>
  );
}
