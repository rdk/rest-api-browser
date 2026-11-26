import { useEffect, useState } from 'preact/hooks';
import { addedHeaders, PROXY } from '../../core/responsetext';
import { fetchEcho, type RunResult } from '../runner';

/** Response headers returned by the server. */
export function ResponseHeadersView({ headers }: { headers: [string, string][] }) {
  return (
    <div class="rab-n-headers" data-testid="response-headers" tabIndex={0}>
      {headers.length === 0 && <div class="rab-n-subtle">No response headers.</div>}
      {headers.map(([k, v], i) => (
        <div class="rab-n-header-row" key={i}><span class="rab-n-header-name">{k}:</span> {v}</div>
      ))}
    </div>
  );
}

/**
 * The request's headers: those the app set, then those the browser and proxies added, as the server received them
 * for a copy of the request (the echo resource), with cookie values and credentials hidden.
 */
export function RequestHeadersView({ result, baseUrl }: { result: RunResult; baseUrl: string }) {
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
