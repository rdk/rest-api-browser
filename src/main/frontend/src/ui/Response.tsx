import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { downloadBlob, fetchEcho, type RunResult } from './runner';
import { buildLines, find, formatJson, visibleLines, type LineModel } from '../core/jsonlines';
import { findRows, rowEnd, wrapRows } from '../core/textrows';
import { VirtualList } from './VirtualList';
import { MaximizeButton, RichTip, Tabs, copyText, download, formatBytes, plural, tabId, useFlash } from './bits';
import { statusInfo, statusTone } from '../core/explain';

const LINE = 20;
/** Pretty cuts a longer line (one DOM text node of megabytes freezes the tab); up to this, it scrolls sideways. */
const PRETTY_LINE = 10_000;
/** Pretty formats bodies up to this size; a larger one (millions of lines) is shown as received, in Raw's view. */
const PRETTY_MAX = 5 * 1024 * 1024;
/** Raw's gutter around its digits (padding, border, margin), in pixels: the rest of the width is for the text. */
const GUTTER_EXTRA_PX = 18;

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
  const tooLarge = !!result && result.kind === 'json' && !result.truncated && (result.text?.length ?? 0) > PRETTY_MAX;
  const model = useMemo(
    () => (result && result.kind === 'json' && !result.truncated && result.text && !tooLarge ? buildLines(result.text) : null),
    [result, tooLarge],
  );
  if (running) {
    return (
      <div class="rab-n-response rab-n-response-state" data-testid="response-running">
        <div class="rab-n-response-state-inner">
          <span role="status"><span class="rab-n-spinner" aria-hidden="true" /> Sending…</span>
          <button class="rab-n-link" onClick={onCancel} title="Cancel the request (Esc)">Cancel</button>
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
        <div class="rab-n-response-state-inner is-error" role="alert">
          <svg class="rab-n-svg rab-n-error" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 5v3.5M8 10.7v.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <span class="rab-n-error">{result.error === 'aborted' ? 'The request was cancelled.' : 'The request failed: ' + result.error}</span>
        </div>
      </div>
    );
  }
  const statusClass = statusTone(result.status);
  const id = idOf(result);
  return (
    <div class={'rab-n-response tone-' + statusClass} data-testid="response">
      {result.sessionExpired && (
        <div class="rab-n-banner" data-testid="session-expired">
          {result.kind === 'html'
            ? 'Your session has expired, so the product answered with its login page.'
            : `The product answered ${[result.status || '', result.statusText || (result.status === 401 ? 'Unauthorized' : '')].filter(Boolean).join(' ')}: you may not be logged in any more.`}{' '}
          <button class="rab-n-link" onClick={() => location.reload()}>Reload to log in again</button>
        </div>
      )}
      <div class="rab-n-statusline">
        {/* the code explained (what it means here, and what to try), outside the live region below */}
        <RichTip testId="status-tip" tip={<StatusTip status={result.status} statusText={result.statusText} />}>
          <span class={'rab-n-status-code ' + statusClass} data-testid="response-status">
            {result.status} {result.statusText}
          </span>
        </RichTip>
        <span class="rab-n-status-text" role="status">
          <span class="rab-n-sr">{result.status} {result.statusText}</span>
          <span class="rab-n-metric">{Math.round(result.durationMs)} ms</span>
          <span class="rab-n-metric">{formatBytes(result.size)}{result.truncated ? ' (truncated)' : ''}</span>
          <span class="rab-n-subtle rab-n-status-url">{result.method} {result.url}</span>
        </span>
        <span class="rab-n-spacer" />
        <MaximizeButton on={maximized} onToggle={onMaximize} what="response" testId="max-bottom" />
      </div>
      <div class="rab-n-tabbar rab-n-tabbar-response">
        <Tabs<View>
          value={view}
          onChange={setView}
          label="The response"
          panelId="rab-n-response-pane"
          tabs={[
            { id: 'pretty', label: 'Pretty' },
            { id: 'raw', label: 'Raw' },
            { id: 'headers', label: `Response headers (${result.headers.length})` },
            { id: 'sent', label: 'Request headers' },
          ]}
        />
        <span class="rab-n-spacer" />
        {(view === 'pretty' || view === 'raw') && result.kind !== 'binary' && result.kind !== 'empty' && (
          <FindBox initial={needle} onFind={setNeedle} onStep={(dir) => setStep((st) => ({ n: st.n + 1, dir }))}
                   count={found.count} index={found.index} unit={view === 'pretty' && model ? 'line' : 'row'} />
        )}
        <div class="rab-n-form-tools">
          <CopyContentButton key={view + id} view={view} result={result} baseUrl={baseUrl} formatted={view === 'pretty' && !!model} />
          <DownloadButton view={view} result={result} baseUrl={baseUrl} formatted={view === 'pretty' && !!model} />
        </div>
      </div>
      {result.truncated && (
        <div class="rab-n-banner">The response is larger than the limit; only its start was read. Downloading saves that part.</div>
      )}
      {tooLarge && view === 'pretty' && (
        <div class="rab-n-banner">The body is too large to format (over {formatBytes(PRETTY_MAX)}): it is shown as received.</div>
      )}
      {result.kind === 'html' && view === 'pretty' && (
        <div class="rab-n-banner">The server answered with an HTML page; its source is shown.</div>
      )}
      <div class="rab-n-response-pane" id="rab-n-response-pane" role="tabpanel" aria-labelledby={tabId('rab-n-response-pane', view)}>
      {view === 'headers' ? (
        <div class="rab-n-headers" data-testid="response-headers" tabIndex={0}>
          {result.headers.length === 0 && <div class="rab-n-subtle">No response headers.</div>}
          {result.headers.map(([k, v], i) => (
            <div class="rab-n-header-row" key={i}><span class="rab-n-header-name">{k}:</span> {v}</div>
          ))}
        </div>
      ) : view === 'sent' ? (
        <RequestHeaders key={'sent' + id} result={result} baseUrl={baseUrl} />
      ) : result.kind === 'binary' ? (
        <div class="rab-n-response-state rab-n-subtle">Binary content ({result.contentType || 'no content type'}). Download it with the button at the right.</div>
      ) : result.kind === 'empty' ? (
        <div class="rab-n-response-state rab-n-subtle">No content.</div>
      ) : view === 'pretty' && model ? (
        <JsonView key={'json' + id} model={model} needle={needle} step={step} onFound={onFound} />
      ) : (
        <TextView key={'text' + id} text={result.text ?? ''} needle={needle} step={step} onFound={onFound} />
      )}
      </div>
    </div>
  );
}

/** The rich tooltip of the response's status code. */
function StatusTip({ status, statusText }: { status: number; statusText: string }) {
  const info = statusInfo(status, statusText);
  return (
    <>
      {(status > 0 || info.title) && <><span class="rab-n-tip-title">{[status || '', info.title].filter(Boolean).join(' ')}</span>{' '}</>}
      <span class="rab-n-tip-text">{info.text}</span>
    </>
  );
}

const EXTENSIONS: Record<string, string> = { json: '.json', xml: '.xml', html: '.html', text: '.txt' };

/**
 * The headers the browser and proxies added, from the echo: those the app did not set itself, with the real body's
 * Content-Length (the echo's copy of the request has no body). The tab and its copy and download share it.
 */
function addedHeaders(result: RunResult, echo: [string, string][]): [string, string][] {
  const ownNames = new Set((result.requestHeaders ?? []).map(([k]) => k.toLowerCase()));
  const added = echo
    .filter(([k]) => !ownNames.has(k.toLowerCase()))
    .map(([k, v]): [string, string] =>
      k.toLowerCase() === 'content-length' && result.requestBodyBytes ? [k, String(result.requestBodyBytes)] : [k, v]);
  if (result.requestBodyBytes && !ownNames.has('content-length') && !added.some(([k]) => k.toLowerCase() === 'content-length')) {
    added.push(['content-length', String(result.requestBodyBytes)]);
  }
  return added;
}

/**
 * What the open tab shows, as text: the headers as "name: value" lines, Pretty a JSON body indented (numbers and keys
 * exactly as received), else the body as received. Null for a body that is empty or not text (binary).
 */
async function textOf(view: View, result: RunResult, baseUrl: string): Promise<string | null> {
  const lines = (pairs: [string, string][]) => pairs.map(([k, v]) => `${k}: ${v}\n`).join('');
  if (view === 'headers') return `HTTP ${result.status} ${result.statusText}\n${lines(result.headers)}`;
  if (view === 'sent') {
    let added: string;
    try {
      added = lines(addedHeaders(result, await fetchEcho(baseUrl, result)));
    } catch (e) {
      added = `# The headers the browser added could not be read: ${e instanceof Error ? e.message : String(e)}\n`;
    }
    return `${result.method} ${result.url}\n${lines(result.requestHeaders ?? [])}${added}`;
  }
  if (result.size === 0 || result.text === undefined) return null;
  if (view === 'pretty' && result.kind === 'json' && !result.truncated && result.text.length <= PRETTY_MAX) {
    const formatted = formatJson(result.text);
    if (formatted !== null) return formatted + '\n';
  }
  return result.text;
}

/** The open tab as a file: its text, or a binary body as received. Null when there is nothing to save. */
async function downloadOf(view: View, result: RunResult, baseUrl: string): Promise<{ blob: Blob; name: string } | null> {
  if (view === 'headers' || view === 'sent') {
    const text = await textOf(view, result, baseUrl);
    return text === null ? null : { blob: new Blob([text], { type: 'text/plain' }), name: view === 'headers' ? 'response-headers.txt' : 'request-headers.txt' };
  }
  if (view === 'pretty' && result.kind === 'json') {
    const text = await textOf(view, result, baseUrl);
    if (text !== null && text !== result.text) return { blob: new Blob([text], { type: 'application/json' }), name: 'response.json' };
  }
  const blob = downloadBlob(result);
  return blob && result.size > 0 ? { blob, name: 'response' + (EXTENSIONS[result.kind] ?? '') } : null;
}

/**
 * One quiet icon left of Download: copies what the open tab shows, as text; a check mark says it worked, a warning
 * sign that it did not. Keyed by the tab and the response, so a new one starts idle.
 */
function CopyContentButton({ view, result, baseUrl, formatted }: { view: View; result: RunResult; baseUrl: string; formatted: boolean }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const flash = useFlash<'done' | 'failed'>(setState);
  const body = view === 'pretty' || view === 'raw';
  const off = body && (result.size === 0 || result.kind === 'binary');
  const what = view === 'headers' ? 'the response\'s headers' : view === 'sent' ? 'the request\'s headers'
    : formatted ? 'the body, formatted' : 'the body';
  const label = off ? (result.kind === 'binary' ? 'A binary body cannot be copied: download it' : 'Nothing to copy: the body is empty')
    : state === 'done' ? 'Copied' : state === 'failed' ? 'The browser did not allow copying' : 'Copy ' + what;
  return (
    <button class={'rab-n-tool' + (state === 'done' ? ' done' : state === 'failed' ? ' failed' : '')} disabled={off} title={label} aria-label={label}
            data-testid="copy-content" data-state={state}
            onClick={async () => {
              const text = await textOf(view, result, baseUrl);
              flash(text !== null && (await copyText(text)) ? 'done' : 'failed');
            }}>
      {state === 'done' ? (
        <svg class="rab-n-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.2 8.4l3 3 6.6-6.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : state === 'failed' ? (
        <svg class="rab-n-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2.4l6 10.6H2L8 2.4z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M8 6.6v2.9M8 11.4v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      ) : (
        <svg class="rab-n-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10.5 5.5V4a1.5 1.5 0 00-1.5-1.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      )}
    </button>
  );
}

/** One quiet icon at the end of the tab bar: downloads what the open tab shows. */
function DownloadButton({ view, result, baseUrl, formatted }: { view: View; result: RunResult; baseUrl: string; formatted: boolean }) {
  const empty = (view === 'pretty' || view === 'raw') && result.size === 0;
  const current = useRef({ view, result });
  current.current = { view, result };
  const what = view === 'headers' ? 'the response\'s headers' : view === 'sent' ? 'the request\'s headers'
    : formatted ? 'the body, formatted' : 'the body as received';
  const label = empty ? 'Nothing to download: the body is empty' : 'Download ' + what;
  return (
    <button class="rab-n-tool" disabled={empty} title={label} aria-label={label} data-testid="download"
            onClick={async () => {
              const file = await downloadOf(view, result, baseUrl);
              if (file && current.current.view === view && current.current.result === result) download(file.blob, file.name);
            }}>
      <svg class="rab-n-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 2.5v7.5M5 7.5L8 10.5l3-3M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
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
  const added = addedHeaders(result, echo ?? []);
  return (
    <div class="rab-n-headers" data-testid="request-headers" tabIndex={0}>
      <div class="rab-n-headers-group">Set by the app <span class="rab-n-headers-count">{own.length}</span></div>
      {own.map(([k, v], i) => (
        <div class="rab-n-header-row" key={'a' + i} data-testid="request-header"><span class="rab-n-header-name">{k}:</span> {v}</div>
      ))}
      <div class="rab-n-headers-group">
        Added by the browser and on the way {echo && <span class="rab-n-headers-count">{added.length}</span>}
      </div>
      {error ? (
        <div class="rab-n-headers-note is-error">They could not be read: {error}.</div>
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
function FindBox({ initial, onFind, onStep, count, index, unit }: {
  initial: string; onFind: (needle: string) => void; onStep: (step: number) => void; count: number; index: number;
  /** What a match counts: Pretty's lines or Raw's rows (several hits on one line are one). */
  unit: 'line' | 'row';
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
            if (e.key === 'Escape' && needle) {
              // clears the box (whatever the browser does on its own), and does nothing else
              e.preventDefault();
              e.stopPropagation();
              clearTimeout(timer.current);
              timer.current = undefined;
              setNeedle('');
              onFind('');
              return;
            }
            // Ctrl+Enter sends the request (Operation), it does not step through the matches
            if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey) return;
            e.preventDefault();
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
      {needle && (
        <span class="rab-n-subtle rab-n-find-count" data-testid="find-count" aria-live="polite">
          {needle !== initial ? '…' : count ? `${index + 1} of ${plural(count, unit)}` : 'no match'}
        </span>
      )}
    </div>
  );
}

/**
 * The matches of the find box in one view: searched again when the needle changes (and when the view opens with
 * one), stepped through on each Enter, reported back for the count beside the box.
 */
function useFind(needle: string, step: Step, onFound: (count: number, index: number) => void, search: (needle: string) => number[],
                 rows?: unknown) {
  const [matches, setMatches] = useState<number[]>([]);
  const [current, setCurrent] = useState(0);
  const searchRef = useRef(search);
  searchRef.current = search;
  useEffect(() => {
    setMatches(needle ? searchRef.current(needle) : []);
    setCurrent(0);
  }, [needle]);
  // the rows changed (Raw wrapped again for a new width): the same needle, searched again, at about the same place
  const firstRows = useRef(rows);
  useEffect(() => {
    if (firstRows.current === rows) return;
    firstRows.current = rows;
    const found = needle ? searchRef.current(needle) : [];
    setMatches(found);
    setCurrent((c) => Math.max(0, Math.min(c, found.length - 1)));
  }, [rows]);
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
  // a step onto a match inside a block folded since the search unfolds the blocks, so the match can be seen; folding
  // a block by hand keeps it folded (only a step or a new search reveals)
  useEffect(() => {
    if (activeLine >= 0 && activeRow < 0 && collapsed.size) setCollapsed(new Set());
  }, [activeLine, step.n]);
  // the horizontal extent of the longest line (its indentation, its text up to the cut, the cut's note), so the
  // sideways scroll does not change as rows come and go; no more than that, or a pane whose lines all fit would get
  // a scrollbar for nothing
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
          const text = line.text.trimStart();
          return (
            <div class={'rab-n-line' + (matchSet.has(i) ? ' match' : '') + (i === activeLine ? ' current' : '')}>
              <span class="rab-n-fold">
                {foldable && (
                  <button class="rab-n-fold-btn" onClick={() => toggle(i)} aria-label={folded ? 'Expand' : 'Collapse'} aria-expanded={!folded}>
                    {folded ? '▸' : '▾'}
                  </button>
                )}
              </span>
              <span class="rab-n-code-text" style={{ paddingLeft: line.depth * 2 + 'ch' }}>
                {text.length > PRETTY_LINE ? text.slice(0, PRETTY_LINE) : text}
                {text.length > PRETTY_LINE && <span class="rab-n-folded"> … {(text.length - PRETTY_LINE).toLocaleString()} more characters (see Raw or Download)</span>}
                {folded && <span class="rab-n-folded"> … {plural(line.foldEnd! - i - 1, 'line')} {closing}</span>}
              </span>
            </div>
          );
        }}
      />
    </div>
  );
}

/**
 * How many characters of the code font fit in the list's width, after a gutter of `digits` characters; measured again
 * when it is resized, and only once it has a width (a pane behind a box on the whole screen has none). 0 until then.
 */
function useColumns(ref: { current: HTMLElement | null }, digits: number): number {
  const [cols, setCols] = useState(0);
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
      timer = setTimeout(measure, 120); // once the resizing stops: wrapping megabytes again takes a moment
    });
    observer?.observe(el);
    const list = el.querySelector('.rab-n-vlist');
    if (list) observer?.observe(list); // its scrollbar appearing narrows it without resizing the wrapper
    return () => {
      observer?.disconnect();
      clearTimeout(timer);
    };
  }, [digits]);
  return cols;
}

const NO_ROWS = wrapRows('', 1);

/** Raw text, wrapped at the pane's width: every character can be seen (minified JSON is one line of megabytes). */
function TextView({ text, needle, step, onFound }: {
  text: string; needle: string; step: Step; onFound: (count: number, index: number) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  // the gutter fits the last line's number (a 20 MB body can have millions of lines)
  const digits = useMemo(() => {
    let lines = 1;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lines++;
    return Math.max(3, String(lines).length);
  }, [text]);
  const cols = useColumns(wrap, digits);
  // nothing is wrapped before the width is known: wrapping megabytes twice on every mount is noticeable
  const rows = useMemo(() => (cols ? wrapRows(text, cols) : NO_ROWS), [text, cols]);
  const { matches, current } = useFind(needle, step, onFound, (n) => findRows(text, rows, n), rows);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const activeRow = matches.length ? matches[current] : -1;
  return (
    <div class="rab-n-code-wrap" ref={wrap} style={{ '--rab-gutter-digits': digits } as any}>
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
            <div class={'rab-n-line' + (matchSet.has(i) ? ' match' : '') + (i === activeRow ? ' current' : '')}>
              <span class="rab-n-gutter">{first ? rows.lines[i] + 1 : ''}</span>
              <span class="rab-n-code-text rab-n-nowrap">{text.slice(rows.starts[i], rowEnd(rows, i, text.length))}</span>
            </div>
          );
        }}
      />
    </div>
  );
}
