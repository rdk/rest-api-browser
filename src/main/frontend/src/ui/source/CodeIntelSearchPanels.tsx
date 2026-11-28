import { useEffect, useRef, useState } from 'preact/hooks';
import {
  fetchBytecodeGrep,
  fetchCallers,
  type CallersResponse,
  type GrepResponse,
} from '../../core/codeintel';
import { describeDetailsError } from '../../core/detailserror';
import type { OpenTabRequest } from '../../core/sourcetabs';

export function CallersPanel({
  baseUrl,
  fqcn,
  defaultMethod,
  bundleId,
  opKey,
  onOpenClass,
}: {
  baseUrl: string;
  fqcn: string;
  defaultMethod?: string;
  bundleId?: number;
  opKey?: string;
  onOpenClass: (req: OpenTabRequest) => void;
}) {
  const [method, setMethod] = useState(defaultMethod ?? '');
  const [pkg, setPkg] = useState('');
  const [submitted, setSubmitted] = useState<{ method: string; pkg: string; seq: number }>({
    method: defaultMethod ?? '',
    pkg: '',
    seq: 0,
  });
  const [data, setData] = useState<CallersResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const reqSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setError(null);
    fetchCallers(baseUrl, {
      className: fqcn,
      method: submitted.method || undefined,
      fromBundle: bundleId,
      opKey,
      packagePrefix: submitted.pkg || undefined,
      limit: 80,
    }).then(
      (res) => {
        if (!mountedRef.current || reqSeqRef.current !== seq) return;
        setData(res);
        setLoading(false);
      },
      (err) => {
        if (!mountedRef.current || reqSeqRef.current !== seq) return;
        setData(null);
        setError(describeDetailsError(err, 'details'));
        setLoading(false);
      },
    );
  }, [baseUrl, fqcn, bundleId, opKey, submitted]);

  const submit = (e: Event) => {
    e.preventDefault();
    setSubmitted((s) => ({ method, pkg, seq: s.seq + 1 }));
  };

  return (
    <div class="rab-n-intel-pane" data-testid="callers-panel">
      <div class="rab-n-modal-outline-head">
        <span>Bytecode Callers</span>
        {data && <span class="rab-n-java-nav-count">{data.count}</span>}
      </div>
      <form class="rab-n-intel-form is-col" onSubmit={submit}>
        <input
          type="search"
          class="rab-n-input"
          placeholder="Method name (optional)…"
          aria-label="Filter caller target method"
          value={method}
          onInput={(e) => setMethod((e.target as HTMLInputElement).value)}
        />
        <div class="rab-n-intel-row">
          <input
            type="search"
            class="rab-n-input"
            placeholder="Caller package prefix…"
            aria-label="Filter caller package prefix"
            value={pkg}
            onInput={(e) => setPkg((e.target as HTMLInputElement).value)}
          />
          <button type="submit" class="rab-n-button" disabled={loading}>Find</button>
        </div>
      </form>
      <div class="rab-n-modal-outline-list">
        {loading ? (
          <div class="rab-n-subtle rab-n-pad">Searching callers…</div>
        ) : error ? (
          <div class="rab-n-java-error rab-n-pad" role="alert">{error}</div>
        ) : data ? (
          data.results.length === 0 ? (
            <div class="rab-n-subtle rab-n-pad">No callers found ({data.scannedClasses} classes scanned).</div>
          ) : (
            <>
              {data.results.map((hit) => (
                <button
                  key={`${hit.bundleId}:${hit.class}`}
                  type="button"
                  class="rab-n-intel-item"
                  onClick={() => onOpenClass({ target: hit.class, candidates: [hit.class], fromBundle: hit.bundleId })}
                  title={hit.class}
                >
                  <div class="rab-n-intel-name">{hit.simpleName}</div>
                  <div class="rab-n-intel-meta">
                    #{hit.bundleId}{hit.plugin ? ` · ${hit.plugin}` : ''} · {hit.calls.length} call{hit.calls.length === 1 ? '' : 's'}
                  </div>
                  {hit.calls.slice(0, 3).map((c, idx) => (
                    <div key={idx} class="rab-n-intel-snippet">{c}</div>
                  ))}
                </button>
              ))}
              {data.truncated && <div class="rab-n-subtle rab-n-pad">Truncated after {data.scannedBundles} bundles.</div>}
            </>
          )
        ) : null}
      </div>
    </div>
  );
}

export function GrepPanel({
  baseUrl,
  bundleId,
  onOpenClass,
}: {
  baseUrl: string;
  bundleId?: number;
  onOpenClass: (req: OpenTabRequest) => void;
}) {
  const hasBundle = bundleId !== undefined && bundleId >= 0;
  const [query, setQuery] = useState('');
  const [bundleOnly, setBundleOnly] = useState(hasBundle);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [data, setData] = useState<GrepResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const reqSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runSearch = (e: Event) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setError(null);
    fetchBytecodeGrep(baseUrl, {
      query: q,
      bundleId: bundleOnly && hasBundle ? bundleId : undefined,
      caseSensitive,
      limit: 80,
    }).then(
      (res) => {
        if (!mountedRef.current || reqSeqRef.current !== seq) return;
        setData(res);
        setLoading(false);
      },
      (err) => {
        if (!mountedRef.current || reqSeqRef.current !== seq) return;
        setData(null);
        setError(describeDetailsError(err, 'details'));
        setLoading(false);
      },
    );
  };

  return (
    <div class="rab-n-intel-pane" data-testid="grep-panel">
      <div class="rab-n-modal-outline-head">
        <span>Bytecode Grep</span>
        {data && <span class="rab-n-java-nav-count">{data.count}</span>}
      </div>
      <form class="rab-n-intel-form is-col" onSubmit={runSearch}>
        <div class="rab-n-intel-row">
          <input
            type="search"
            class="rab-n-input"
            placeholder="Substring in bytecode…"
            aria-label="Bytecode grep query"
            data-testid="grep-query-input"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
          <button type="submit" class="rab-n-button" data-testid="grep-submit" disabled={loading || !query.trim()}>
            Search
          </button>
        </div>
        <div class="rab-n-intel-row">
          {hasBundle && (
            <label class="rab-n-intel-check">
              <input type="checkbox" checked={bundleOnly} onChange={(e) => setBundleOnly((e.target as HTMLInputElement).checked)} />
              Bundle #{bundleId} only
            </label>
          )}
          <label class="rab-n-intel-check">
            <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive((e.target as HTMLInputElement).checked)} />
            Case
          </label>
        </div>
      </form>
      <div class="rab-n-modal-outline-list">
        {loading ? (
          <div class="rab-n-subtle rab-n-pad">Grepping bytecode…</div>
        ) : error ? (
          <div class="rab-n-java-error rab-n-pad" role="alert">{error}</div>
        ) : !data ? (
          <div class="rab-n-subtle rab-n-pad">Enter a constant-pool substring (class/method name, annotation, property key, URL) and press Search.</div>
        ) : data.results.length === 0 ? (
          <div class="rab-n-subtle rab-n-pad">{data.hint ?? 'No matches found.'}</div>
        ) : (
          <>
            {data.results.map((hit) => (
              <button
                key={`${hit.bundleId}:${hit.class}`}
                type="button"
                class="rab-n-intel-item"
                onClick={() => onOpenClass({ target: hit.class, candidates: [hit.class], fromBundle: hit.bundleId })}
                title={hit.class}
              >
                <div class="rab-n-intel-name">{hit.simpleName}</div>
                <div class="rab-n-intel-meta">#{hit.bundleId}{hit.plugin ? ` · ${hit.plugin}` : ''}</div>
                {hit.matches.slice(0, 3).map((m, idx) => (
                  <div key={idx} class="rab-n-intel-snippet">{m}</div>
                ))}
              </button>
            ))}
            {data.truncated && <div class="rab-n-subtle rab-n-pad">Results truncated ({data.scannedClasses} classes).</div>}
          </>
        )}
      </div>
    </div>
  );
}
