import { useEffect, useRef, useState } from 'preact/hooks';
import {
  fetchBundleResourceContent,
  fetchBundleResourceList,
  type BundleResourceContentResponse,
  type BundleResourceEntry,
} from '../../core/codeintel';
import { describeDetailsError } from '../../core/detailserror';
import { CopyButton, formatBytes } from '../bits';

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
