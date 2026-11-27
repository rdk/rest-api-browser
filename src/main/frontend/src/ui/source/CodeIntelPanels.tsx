import { useEffect, useRef, useState } from 'preact/hooks';
import {
  fetchBundleResourceContent,
  fetchBundleResourceList,
  fetchBytecodeGrep,
  fetchCallers,
  fetchImplementations,
  type BundleResourceContentResponse,
  type BundleResourceEntry,
  type CallersResponse,
  type GrepResponse,
  type ImplementationsResponse,
} from '../../core/codeintel';
import { describeDetailsError } from '../../core/detailserror';
import type { OpenTabRequest } from '../../core/sourcetabs';
import { tipProps } from '../../core/uitips';
import { CopyButton, formatBytes } from '../bits';

export type SourcePanelMode = 'outline' | 'implementations' | 'callers' | 'grep' | 'resources';

const PANELS: { id: SourcePanelMode; label: string; title: string; testId: string }[] = [
  { id: 'outline', label: 'Outline', title: 'Constructors, methods, and REST endpoints in this class', testId: 'source-panel-outline' },
  { id: 'implementations', label: 'Impls', title: 'Find implementations, subclasses, and OSGi services for this type', testId: 'source-panel-implementations' },
  { id: 'callers', label: 'Callers', title: 'Find bytecode callers referencing this class or method', testId: 'source-panel-callers' },
  { id: 'grep', label: 'Grep', title: 'Search constant-pool strings across OSGi bundles', testId: 'source-panel-grep' },
  { id: 'resources', label: 'Files', title: 'Browse descriptor XML, templates, and resources in this OSGi bundle', testId: 'source-panel-resources' },
];

export function SourcePanelTabs({
  mode,
  onChange,
}: {
  mode: SourcePanelMode;
  onChange: (m: SourcePanelMode) => void;
}) {
  return (
    <div class="rab-n-panel-tabs" role="tablist" aria-label="Class intelligence panels" data-testid="source-panel-tabs">
      {PANELS.map((p) => (
        <button
          key={p.id}
          type="button"
          role="tab"
          aria-selected={mode === p.id}
          class={'rab-n-panel-tab' + (mode === p.id ? ' on' : '')}
          data-testid={p.testId}
          onClick={() => onChange(p.id)}
          {...tipProps({ title: p.label, body: p.title })}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

export function ImplementationsPanel({
  baseUrl,
  fqcn,
  bundleId,
  opKey,
  onOpenClass,
}: {
  baseUrl: string;
  fqcn: string;
  bundleId?: number;
  opKey?: string;
  onOpenClass: (req: OpenTabRequest) => void;
}) {
  const [includeAbstract, setIncludeAbstract] = useState(false);
  const [data, setData] = useState<ImplementationsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);
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
    fetchImplementations(baseUrl, {
      className: fqcn,
      fromBundle: bundleId,
      opKey,
      includeAbstract,
      limit: 100,
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
  }, [baseUrl, fqcn, bundleId, opKey, includeAbstract, reloadSeq]);

  return (
    <div class="rab-n-intel-pane" data-testid="implementations-panel">
      <div class="rab-n-modal-outline-head">
        <span>Implementations</span>
        {data && <span class="rab-n-java-nav-count">{data.implementationCount + data.serviceCount}</span>}
      </div>
      <div class="rab-n-intel-form">
        <label class="rab-n-intel-check">
          <input
            type="checkbox"
            checked={includeAbstract}
            onChange={(e) => setIncludeAbstract((e.target as HTMLInputElement).checked)}
          />
          Include abstract
        </label>
        <span class="rab-n-spacer" />
        <button type="button" class="rab-n-quiet" onClick={() => setReloadSeq((n) => n + 1)} disabled={loading}>
          Refresh
        </button>
      </div>
      <div class="rab-n-modal-outline-list">
        {loading ? (
          <div class="rab-n-subtle rab-n-pad">Scanning OSGi bundles…</div>
        ) : error ? (
          <div class="rab-n-java-error rab-n-pad" role="alert">{error}</div>
        ) : data ? (
          <>
            {data.osgiServices.length > 0 && (
              <div class="rab-n-intel-section">
                <div class="rab-n-intel-subtitle">OSGi services ({data.osgiServices.length})</div>
                {data.osgiServices.map((svc) => (
                  <div key={svc.serviceId} class="rab-n-intel-item is-static">
                    <div class="rab-n-intel-name">{svc.beanName || svc.objectClass.join(', ')}</div>
                    <div class="rab-n-intel-meta">
                      bundle #{svc.bundleId}{svc.plugin ? ` · ${svc.plugin}` : ''} · rank {svc.ranking}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {data.implementations.length === 0 ? (
              <div class="rab-n-subtle rab-n-pad">No implementations found.</div>
            ) : (
              data.implementations.map((hit) => (
                <button
                  key={`${hit.bundleId}:${hit.class}`}
                  type="button"
                  class="rab-n-intel-item"
                  onClick={() => onOpenClass({ target: hit.class, candidates: [hit.class], fromBundle: hit.bundleId })}
                  title={hit.class}
                >
                  <div class="rab-n-intel-name">{hit.simpleName}</div>
                  <div class="rab-n-intel-meta">
                    {hit.via} · #{hit.bundleId}{hit.plugin ? ` · ${hit.plugin}` : ''}{hit.abstract ? ' · abstract' : ''}
                  </div>
                </button>
              ))
            )}
            {data.truncated && <div class="rab-n-subtle rab-n-pad">Results truncated ({data.scannedBundles} bundles scanned).</div>}
          </>
        ) : null}
      </div>
    </div>
  );
}

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

export function BundleResourcesPanel({
  baseUrl,
  bundleId,
  pluginKey,
  selectedPath,
  onSelectPath,
}: {
  baseUrl: string;
  bundleId?: number;
  pluginKey?: string;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
}) {
  const hasTarget = (bundleId !== undefined && bundleId >= 0) || !!pluginKey;
  const [prefix, setPrefix] = useState('');
  const [appliedPrefix, setAppliedPrefix] = useState('');
  const [entries, setEntries] = useState<BundleResourceEntry[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [truncated, setTruncated] = useState(false);
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
    if (!hasTarget) {
      setEntries([]);
      setTotalCount(null);
      return;
    }
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setError(null);
    fetchBundleResourceList(baseUrl, {
      bundleId,
      pluginKey,
      prefix: appliedPrefix || undefined,
      limit: 200,
    }).then(
      (res) => {
        if (!mountedRef.current || reqSeqRef.current !== seq) return;
        setEntries(res.entries);
        setTotalCount(res.count);
        setTruncated(res.truncated);
        setLoading(false);
      },
      (err) => {
        if (!mountedRef.current || reqSeqRef.current !== seq) return;
        setEntries([]);
        setError(describeDetailsError(err, 'details'));
        setLoading(false);
      },
    );
  }, [baseUrl, hasTarget, bundleId, pluginKey, appliedPrefix]);

  const applyFilter = (e: Event) => {
    e.preventDefault();
    setAppliedPrefix(prefix.trim());
  };

  return (
    <div class="rab-n-intel-pane" data-testid="resources-panel">
      <div class="rab-n-modal-outline-head">
        <span>Bundle Files</span>
        {totalCount !== null && <span class="rab-n-java-nav-count">{totalCount}</span>}
      </div>
      <form class="rab-n-intel-form" onSubmit={applyFilter}>
        <input
          type="search"
          class="rab-n-input"
          placeholder="Path prefix (e.g. templates/)…"
          aria-label="Filter bundle resource path prefix"
          value={prefix}
          onInput={(e) => setPrefix((e.target as HTMLInputElement).value)}
        />
        <button type="submit" class="rab-n-button" disabled={loading || !hasTarget}>Filter</button>
      </form>
      <div class="rab-n-modal-outline-list">
        {!hasTarget ? (
          <div class="rab-n-subtle rab-n-pad">Bundle ID is not known for this class yet.</div>
        ) : loading ? (
          <div class="rab-n-subtle rab-n-pad">Listing bundle resources…</div>
        ) : error ? (
          <div class="rab-n-java-error rab-n-pad" role="alert">{error}</div>
        ) : entries.length === 0 ? (
          <div class="rab-n-subtle rab-n-pad">No matching files in bundle.</div>
        ) : (
          <>
            {entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                class={'rab-n-intel-item' + (selectedPath === entry.path ? ' on' : '')}
                data-testid="bundle-resource-item"
                data-path={entry.path}
                onClick={() => onSelectPath(entry.path)}
                title={entry.path}
              >
                <div class="rab-n-intel-name">{entry.path.split('/').pop() || entry.path}</div>
                <div class="rab-n-intel-meta">{entry.kind} · {entry.path}</div>
              </button>
            ))}
            {truncated && <div class="rab-n-subtle rab-n-pad">List truncated (filter by path prefix to narrow).</div>}
          </>
        )}
      </div>
    </div>
  );
}

export function ResourcePreviewPane({
  baseUrl,
  bundleId,
  pluginKey,
  path,
  onClose,
}: {
  baseUrl: string;
  bundleId?: number;
  pluginKey?: string;
  path: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<BundleResourceContentResponse | null>(null);
  const [loading, setLoading] = useState(true);
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
    fetchBundleResourceContent(baseUrl, { bundleId, pluginKey, path, maxLines: 500 }).then(
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
  }, [baseUrl, bundleId, pluginKey, path]);

  return (
    <div class="rab-n-res-preview" data-testid="bundle-resource-preview">
      <div class="rab-n-res-head">
        <code class="rab-n-res-path">{path}</code>
        {data && (
          <span class="rab-n-subtle">
            {data.kind} · {formatBytes(data.bytes)} · {data.totalLines} line{data.totalLines === 1 ? '' : 's'}
            {data.truncated ? ` (showing ${data.startLine}-${data.endLine})` : ''}
          </span>
        )}
        <span class="rab-n-spacer" />
        {data && <CopyButton quiet label="Copy file" text={() => data.content} />}
        <button type="button" class="rab-n-button" data-testid="bundle-resource-close" onClick={onClose}>
          Back to source
        </button>
      </div>
      {loading ? (
        <div class="rab-n-pad rab-n-subtle">Loading {path}…</div>
      ) : error ? (
        <div class="rab-n-pad rab-n-java-error" role="alert">{error}</div>
      ) : data ? (
        <pre class="rab-n-res-code">{data.content}</pre>
      ) : null}
    </div>
  );
}
