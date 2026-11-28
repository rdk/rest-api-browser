import { useEffect, useRef, useState } from 'preact/hooks';
import {
  fetchImplementations,
  type ImplementationsResponse,
} from '../../core/codeintel';
import { describeDetailsError } from '../../core/detailserror';
import type { OpenTabRequest } from '../../core/sourcetabs';
import { tipProps } from '../../core/uitips';

export { CallersPanel, GrepPanel } from './CodeIntelSearchPanels';
export { BundleResourcesPanel, ResourcePreviewPane } from './BundleResourcePanels';

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
