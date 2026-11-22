import { useEffect, useMemo, useState } from 'preact/hooks';
import type { RunResult } from './runner';
import { buildLines, find, visibleLines, type LineModel } from '../core/jsonlines';
import { VirtualList } from './VirtualList';
import { Tabs, download, formatBytes } from './bits';

const LINE = 20;

type View = 'pretty' | 'raw' | 'headers';

export function ResponseView({ result, running, onCancel }: {
  result: RunResult | null; running: boolean; onCancel: () => void;
}) {
  const [view, setView] = useState<View>('pretty');
  if (running) {
    return (
      <div class="rab-n-response rab-n-response-state" data-testid="response-running">
        <span class="rab-n-spinner" /> Sending… <button class="rab-n-link" onClick={onCancel}>Cancel (Esc)</button>
      </div>
    );
  }
  if (!result) {
    return <div class="rab-n-response rab-n-response-state rab-n-subtle">Send the request to see the response here.</div>;
  }
  if (result.error) {
    return (
      <div class="rab-n-response rab-n-response-state" data-testid="response-error">
        <span class="rab-n-error">{result.error === 'aborted' ? 'The request was cancelled.' : 'The request failed: ' + result.error}</span>
      </div>
    );
  }
  const statusClass = result.status >= 500 ? 'err' : result.status >= 400 ? 'warn' : result.status >= 300 ? 'info' : 'ok';
  const fileName = 'response' + (result.kind === 'json' ? '.json' : result.kind === 'xml' ? '.xml' : result.kind === 'html' ? '.html' : '');
  return (
    <div class="rab-n-response" data-testid="response">
      {result.sessionExpired && (
        <div class="rab-n-banner" data-testid="session-expired">
          Your session has expired, so the product answered with its login page.{' '}
          <button class="rab-n-link" onClick={() => location.reload()}>Reload to log in again</button>
        </div>
      )}
      <div class="rab-n-statusline">
        <span class={'rab-n-status-code ' + statusClass} data-testid="response-status">{result.status} {result.statusText}</span>
        <span class="rab-n-subtle">{Math.round(result.durationMs)} ms</span>
        <span class="rab-n-subtle">{formatBytes(result.size)}{result.truncated ? ' (truncated)' : ''}</span>
        <span class="rab-n-subtle rab-n-ellipsis" title={result.url}>{result.method} {result.url}</span>
        <span class="rab-n-spacer" />
        {result.blob && <button class="rab-n-button" onClick={() => download(result.blob!, fileName)}>Download</button>}
      </div>
      <Tabs<View>
        value={view}
        onChange={setView}
        tabs={[
          { id: 'pretty', label: 'Pretty' },
          { id: 'raw', label: 'Raw' },
          { id: 'headers', label: `Headers (${result.headers.length})` },
        ]}
      />
      {result.truncated && (
        <div class="rab-n-banner">The response is larger than the limit; only its start was read. Download saves that part.</div>
      )}
      {view === 'headers' ? (
        <div class="rab-n-headers" data-testid="response-headers">
          {result.headers.map(([k, v]) => (
            <div key={k + v}><span class="rab-n-header-name">{k}:</span> {v}</div>
          ))}
        </div>
      ) : result.kind === 'binary' ? (
        <div class="rab-n-response-state rab-n-subtle">Binary content ({result.contentType || 'no content type'}). Use Download.</div>
      ) : result.kind === 'empty' ? (
        <div class="rab-n-response-state rab-n-subtle">No content.</div>
      ) : view === 'pretty' && result.kind === 'json' ? (
        <JsonView text={result.text ?? ''} />
      ) : (
        <>
          {result.kind === 'html' && view === 'pretty' && (
            <div class="rab-n-banner">The server answered with an HTML page; its source is shown.</div>
          )}
          <TextView text={result.text ?? ''} />
        </>
      )}
    </div>
  );
}

function FindBox({ onFind, count, index }: { onFind: (needle: string, step: number) => void; count: number; index: number }) {
  const [needle, setNeedle] = useState('');
  return (
    <div class="rab-n-find">
      <input
        type="search"
        placeholder="Find in response"
        value={needle}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          setNeedle(v);
          onFind(v, 0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onFind(needle, e.shiftKey ? -1 : 1);
        }}
        aria-label="Find in response"
      />
      {needle && <span class="rab-n-subtle">{count ? `${index + 1} of ${count}` : 'no match'}</span>}
    </div>
  );
}

/** A folding JSON view over the flat line model: only visible lines are rendered. */
function JsonView({ text }: { text: string }) {
  const model: LineModel | null = useMemo(() => buildLines(text), [text]);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [matches, setMatches] = useState<number[]>([]);
  const [current, setCurrent] = useState(0);
  useEffect(() => {
    setCollapsed(new Set());
    setMatches([]);
  }, [text]);
  const visible = useMemo(() => (model ? visibleLines(model, collapsed) : []), [model, collapsed]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  if (!model) return <TextView text={text} />;
  const activeLine = matches.length ? matches[current] : -1;
  const onFind = (needle: string, step: number) => {
    if (!needle) {
      setMatches([]);
      return;
    }
    const found = find(model, needle);
    if (found.length && collapsed.size) setCollapsed(new Set()); // a match may sit inside a folded block
    setMatches(found);
    setCurrent((c) => (found.length ? (step === 0 ? 0 : (c + step + found.length) % found.length) : 0));
  };
  const toggle = (i: number) => {
    const next = new Set(collapsed);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setCollapsed(next);
  };
  return (
    <div class="rab-n-code-wrap">
      <FindBox onFind={onFind} count={matches.length} index={current} />
      <VirtualList
        className="rab-n-code"
        count={visible.length}
        rowHeight={LINE}
        activeIndex={activeLine >= 0 ? visible.indexOf(activeLine) : undefined}
        renderRow={(row) => {
          const i = visible[row];
          const line = model.lines[i];
          const foldable = line.foldEnd !== undefined;
          const folded = foldable && collapsed.has(i);
          const closing = folded ? model.lines[line.foldEnd!].text.trim() : '';
          return (
            <div class={'rab-n-line' + (matchSet.has(i) ? ' match' : '') + (i === activeLine ? ' current' : '')}>
              <span class="rab-n-gutter">{i + 1}</span>
              <span class="rab-n-fold">
                {foldable && (
                  <button class="rab-n-fold-btn" onClick={() => toggle(i)} aria-label={folded ? 'Expand' : 'Collapse'}>
                    {folded ? '▸' : '▾'}
                  </button>
                )}
              </span>
              <span class="rab-n-code-text" style={{ paddingLeft: line.depth * 2 + 'ch' }}>
                {line.text.trimStart()}
                {folded && <span class="rab-n-folded"> … {line.foldEnd! - i - 1} lines {closing}</span>}
              </span>
            </div>
          );
        }}
      />
    </div>
  );
}

function TextView({ text }: { text: string }) {
  const lines = useMemo(() => text.split('\n'), [text]);
  const [matches, setMatches] = useState<number[]>([]);
  const [current, setCurrent] = useState(0);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const onFind = (needle: string, step: number) => {
    const n = needle.toLowerCase();
    const found = n ? lines.flatMap((l, i) => (l.toLowerCase().includes(n) ? [i] : [])) : [];
    setMatches(found);
    setCurrent((c) => (found.length ? (step === 0 ? 0 : (c + step + found.length) % found.length) : 0));
  };
  const activeLine = matches.length ? matches[current] : -1;
  return (
    <div class="rab-n-code-wrap">
      <FindBox onFind={onFind} count={matches.length} index={current} />
      <VirtualList
        className="rab-n-code"
        count={lines.length}
        rowHeight={LINE}
        activeIndex={activeLine >= 0 ? activeLine : undefined}
        renderRow={(i) => (
          <div class={'rab-n-line' + (matchSet.has(i) ? ' match' : '') + (i === activeLine ? ' current' : '')}>
            <span class="rab-n-gutter">{i + 1}</span>
            <span class="rab-n-code-text rab-n-nowrap">{lines[i]}</span>
          </div>
        )}
      />
    </div>
  );
}
