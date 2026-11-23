import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { downloadBlob, fetchEcho, type RunResult } from './runner';
import { buildLines, find, visibleLines, type LineModel } from '../core/jsonlines';
import { VirtualList } from './VirtualList';
import { MaximizeButton, Tabs, download, formatBytes } from './bits';

const LINE = 20;
/** Longer lines are split into rows (raw text) or cut (JSON): one DOM text node of megabytes freezes the tab. */
const MAX_LINE = 2000;

type View = 'pretty' | 'raw' | 'headers' | 'sent';
/** A request to move to the next (dir 1) or previous (dir -1) match; n counts the requests. */
type Step = { n: number; dir: number };

let resultSeq = 0;
const resultIds = new WeakMap<RunResult, number>();
const idOf = (r: RunResult) => {
  let id = resultIds.get(r);
  if (id === undefined) resultIds.set(r, (id = ++resultSeq));
  return id;
};

export function ResponseView({ result, running, onCancel, maximized, onMaximize, baseUrl }: {
  result: RunResult | null; running: boolean; onCancel: () => void; maximized: boolean; onMaximize: () => void; baseUrl: string;
}) {
  const [view, setView] = useState<View>('pretty');
  // the find box sits in the tab bar; Pretty and Raw do the matching and report the count back
  const [needle, setNeedle] = useState('');
  const [step, setStep] = useState<Step>({ n: 0, dir: 1 });
  const [found, setFound] = useState({ count: 0, index: 0 });
  const onFound = useCallback((count: number, index: number) => setFound({ count, index }), []);
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
      <div class="rab-n-tabbar rab-n-tabbar-response">
        <Tabs<View>
          value={view}
          onChange={setView}
          tabs={[
            { id: 'pretty', label: 'Pretty' },
            { id: 'raw', label: 'Raw' },
            { id: 'headers', label: `Response headers (${result.headers.length})` },
            { id: 'sent', label: 'Request headers' },
          ]}
        />
        {(view === 'pretty' || view === 'raw') && result.kind !== 'binary' && result.kind !== 'empty' && (
          <FindBox initial={needle} onFind={setNeedle} onStep={(dir) => setStep((st) => ({ n: st.n + 1, dir }))}
                   count={found.count} index={found.index} />
        )}
        <span class="rab-n-spacer" />
        <div class="rab-n-form-tools">
          <MaximizeButton on={maximized} onToggle={onMaximize} what="response" testId="max-bottom" />
        </div>
      </div>
      {result.truncated && (
        <div class="rab-n-banner">The response is larger than the limit; only its start was read. Download saves that part.</div>
      )}
      {view === 'headers' ? (
        <div class="rab-n-headers" data-testid="response-headers">
          {result.headers.map(([k, v], i) => (
            <div class="rab-n-header-row" key={i}><span class="rab-n-header-name">{k}:</span> {v}</div>
          ))}
        </div>
      ) : view === 'sent' ? (
        <RequestHeaders key={'sent' + id} result={result} baseUrl={baseUrl} />
      ) : result.kind === 'binary' ? (
        <div class="rab-n-response-state rab-n-subtle">Binary content ({result.contentType || 'no content type'}). Use Download.</div>
      ) : result.kind === 'empty' ? (
        <div class="rab-n-response-state rab-n-subtle">No content.</div>
      ) : view === 'pretty' && model ? (
        <JsonView key={'json' + id} model={model} needle={needle} step={step} onFound={onFound} />
      ) : (
        <>
          {result.kind === 'html' && view === 'pretty' && (
            <div class="rab-n-banner">The server answered with an HTML page; its source is shown.</div>
          )}
          <TextView key={'text' + id} text={result.text ?? ''} needle={needle} step={step} onFound={onFound} />
        </>
      )}
    </div>
  );
}

/** Headers that proxies add on the way, told apart from the browser's. */
const PROXY = /^(x-forwarded-|forwarded$|via$|x-real-ip$|x-request-id$|x-amzn-|x-b3-|traceparent$|true-client-ip$|cf-)/i;

/**
 * The request's headers: those the app set, then those the browser and proxies added, as the server received them
 * for a copy of the request (the echo resource), with cookie values and credentials hidden.
 */
function RequestHeaders({ result, baseUrl }: { result: RunResult; baseUrl: string }) {
  const [echo, setEcho] = useState<[string, string][] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchEcho(baseUrl, result).then(
      (h) => live && setEcho(h),
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [result, baseUrl]);
  const own = result.requestHeaders ?? [];
  const ownNames = new Set(own.map(([k]) => k.toLowerCase()));
  const added = (echo ?? [])
    .filter(([k]) => !ownNames.has(k.toLowerCase()))
    .map(([k, v]): [string, string] =>
      k.toLowerCase() === 'content-length' && result.requestBodyBytes ? [k, String(result.requestBodyBytes)] : [k, v]);
  return (
    <div class="rab-n-headers" data-testid="request-headers">
      <div class="rab-n-headers-group">Set by the app <span class="rab-n-headers-count">{own.length}</span></div>
      {own.map(([k, v], i) => (
        <div class="rab-n-header-row" key={'a' + i} data-testid="request-header"><span class="rab-n-header-name">{k}:</span> {v}</div>
      ))}
      <div class="rab-n-headers-group">
        Added by the browser and on the way {echo && <span class="rab-n-headers-count">{added.length}</span>}
      </div>
      {error ? (
        <div class="rab-n-headers-note rab-n-error">They could not be read: {error}.</div>
      ) : !echo ? (
        <div class="rab-n-headers-note"><span class="rab-n-spinner" aria-hidden="true" /> Asking the server what it receives…</div>
      ) : (
        added.map(([k, v], i) => (
          <div class="rab-n-header-row" key={'b' + i} data-testid="browser-header">
            <span class="rab-n-header-name">{k}:</span> {v}
            {PROXY.test(k) && <span class="rab-n-header-tag">proxy</span>}
          </div>
        ))
      )}
      <div class="rab-n-headers-note">
        As the server received a copy of this request (the same method and headers, without the body), sent to the
        plugin's echo resource when this tab opened. Cookie values and credentials are hidden.
      </div>
    </div>
  );
}

/** Find as you type, 150 ms after the last key; Enter and Shift+Enter step through the matches. */
function FindBox({ initial, onFind, onStep, count, index }: {
  initial: string; onFind: (needle: string) => void; onStep: (step: number) => void; count: number; index: number;
}) {
  const [needle, setNeedle] = useState(initial);
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
      {needle && <span class="rab-n-subtle rab-n-find-count" data-testid="find-count">{count ? `${index + 1} of ${count}` : 'no match'}</span>}
    </div>
  );
}

/**
 * The matches of the find box in one view: searched again when the needle changes (and when the view opens with
 * one), stepped through on each Enter, reported back for the count beside the box.
 */
function useFind(needle: string, step: Step, onFound: (count: number, index: number) => void, search: (needle: string) => number[]) {
  const [matches, setMatches] = useState<number[]>([]);
  const [current, setCurrent] = useState(0);
  const searchRef = useRef(search);
  searchRef.current = search;
  useEffect(() => {
    setMatches(needle ? searchRef.current(needle) : []);
    setCurrent(0);
  }, [needle]);
  const seen = useRef(step.n);
  useEffect(() => {
    if (step.n === seen.current) return; // a step made before this view opened
    seen.current = step.n;
    if (matches.length) setCurrent((c) => (c + step.dir + matches.length) % matches.length);
  }, [step]);
  useEffect(() => onFound(matches.length, current), [matches, current]);
  return { matches, current };
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
function JsonView({ model, needle, step, onFound }: {
  model: LineModel; needle: string; step: Step; onFound: (count: number, index: number) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const { matches, current } = useFind(needle, step, onFound, (n) => {
    const found = find(model, n);
    if (found.length) setCollapsed((c) => (c.size ? new Set() : c)); // a match may sit inside a folded block
    return found;
  });
  const visible = useMemo(() => visibleLines(model, collapsed), [model, collapsed]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const activeLine = matches.length ? matches[current] : -1;
  const toggle = (i: number) => {
    const next = new Set(collapsed);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setCollapsed(next);
  };
  const activeRow = activeLine >= 0 ? indexIn(visible, activeLine) : -1;
  return (
    <div class="rab-n-code-wrap">
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
function TextView({ text, needle, step, onFound }: {
  text: string; needle: string; step: Step; onFound: (count: number, index: number) => void;
}) {
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
  const { matches, current } = useFind(needle, step, onFound, (needleText) => {
    const n = needleText.toLowerCase();
    const found: number[] = [];
    if (!lower.current) lower.current = rows.map((r) => r.text.toLowerCase());
    const l = lower.current;
    for (let i = 0; i < l.length; i++) if (l[i].includes(n)) found.push(i);
    return found;
  });
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const activeRow = matches.length ? matches[current] : -1;
  return (
    <div class="rab-n-code-wrap">
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
