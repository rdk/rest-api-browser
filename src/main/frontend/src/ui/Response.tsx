import { useCallback, useMemo, useState } from 'preact/hooks';
import { statusTone } from '../core/explain';
import { buildLines } from '../lib/json-lines';
import { PRETTY_MAX, type ResponseViewKind } from '../core/responsetext';
import { tipProps } from '../core/uitips';
import { formatBytes, MaximizeButton, RichTip, Tabs, tabId } from './bits';
import { RequestHeadersView, ResponseHeadersView } from './response/HeadersView';
import { JsonView } from './response/JsonView';
import { CopyContentButton, DownloadButton, FindBox, StatusTip } from './response/ResponseToolbar';
import { TextView } from './response/TextView';
import type { Step } from './response/useFind';
import type { RunResult } from './runner';

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
  const [view, setView] = useState<ResponseViewKind>('pretty');
  const [needle, setNeedle] = useState('');
  const [step, setStep] = useState<Step>({ n: 0, dir: 1 });
  const [found, setFound] = useState({ count: 0, index: 0, forNeedle: '' });
  const onFound = useCallback((count: number, index: number, forNeedle: string) => {
    setFound({ count, index, forNeedle });
  }, []);

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
          <button class="rab-n-link" onClick={onCancel} {...tipProps({ title: 'Cancel request', body: 'Abort the in-flight HTTP request.', shortcut: 'Esc' })}>Cancel</button>
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
        <Tabs<ResponseViewKind>
          value={view}
          onChange={setView}
          label="The response"
          panelId="rab-n-response-pane"
          tabs={[
            { id: 'pretty', label: 'Pretty', tip: { title: 'Pretty view', body: 'Syntax-highlighted, collapsible view of JSON responses.' } },
            { id: 'raw', label: 'Raw', tip: { title: 'Raw response', body: 'Exact unformatted response body as returned by the server.' } },
            { id: 'headers', label: `Response headers (${result.headers.length})`, tip: { title: 'Response headers', body: 'HTTP headers returned by the server (content type, caching, security, node ID, etc.).' } },
            { id: 'sent', label: 'Request headers', tip: { title: 'Request headers', body: 'Headers set by the app plus headers added by your browser and proxies (secrets redacted).' } },
          ]}
        />
        <span class="rab-n-spacer" />
        {(view === 'pretty' || view === 'raw') && result.kind !== 'binary' && result.kind !== 'empty' && (
          <FindBox initial={needle} reportedNeedle={found.forNeedle} onFind={setNeedle}
                   onStep={(dir) => setStep((st) => ({ n: st.n + 1, dir }))}
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
          <ResponseHeadersView headers={result.headers} />
        ) : view === 'sent' ? (
          <RequestHeadersView key={'sent' + id} result={result} baseUrl={baseUrl} />
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
