import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { fetchPluginInfo, type PluginDetailInfo } from '../../core/details';
import { formatIsoTime } from '../../core/detailserror';
import type { Module } from '../../core/types';
import { plural, RichTip, safeHref } from '../bits';
import { originLabel, sourceLabel, stabilityLabel } from '../../core/facts';

/**
 * Rich App lozenge ("App: <plugin name>") with a hover + click-to-pin tooltip showing all available plugin,
 * REST module, lifecycle timestamps, dependencies, and OSGi bundle details (enriched via `/code/plugin` for sysadmins).
 */
export function AppLozenge({ baseUrl, module, sysadmin }: { baseUrl: string; module: Module; sysadmin?: boolean }) {
  const [info, setInfo] = useState<PluginDetailInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requested = useRef(false);
  const mountedRef = useRef(true);
  const seqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      seqRef.current++;
    };
  }, []);

  useEffect(() => {
    seqRef.current++;
    setInfo(null);
    setLoading(false);
    setError(null);
    requested.current = false;
  }, [module.plugin.key, baseUrl, sysadmin]);

  const load = () => {
    if (!sysadmin || requested.current) return;
    requested.current = true;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    fetchPluginInfo(baseUrl, module.plugin.key).then(
      (d) => {
        if (!mountedRef.current || seq !== seqRef.current) return;
        setInfo(d);
        setLoading(false);
      },
      (e) => {
        if (!mountedRef.current || seq !== seqRef.current) return;
        requested.current = false;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
  };

  const dates = info
    ? ([['Installed', info.installed], ['Loaded', info.loaded], ['Enabled', info.enabled]]
      .filter(([, v]) => v) as [string, string][])
    : [];
  const vendorHref = safeHref(info?.vendorUrl);

  const tip = (
    <div class="rab-n-app-tip-body">
      <div class="rab-n-class-tip-head">
        <span class="rab-n-class-kind kind-interface">app</span>
        <strong class="rab-n-class-tip-name">{info?.name ?? module.plugin.name}</strong>
        {(info?.version ?? module.plugin.version) && (
          <span class="rab-n-subtle rab-n-card-mono">v{info?.version ?? module.plugin.version}</span>
        )}
      </div>
      <div class="rab-n-class-tip-fqcn">{module.plugin.key}</div>
      {info?.description && <div class="rab-n-card-summary">{info.description}</div>}
      {loading && (
        <div class="rab-n-subtle rab-n-class-tip-status">
          <span class="rab-n-spinner" aria-hidden="true" /> Loading plugin &amp; OSGi details…
        </div>
      )}
      {error && !loading && <div class="rab-n-card-error rab-n-class-tip-status">Extra details unavailable: {error}</div>}
      <dl class="rab-n-card-facts rab-n-class-tip-facts">
        <Row name="Origin">{originLabel(module)} · {stabilityLabel(module)}</Row>
        {info && (
          <Row name="State">
            <span class={info.state === 'ENABLED' ? 'rab-n-java-ok' : 'rab-n-java-deprecated'}>{info.state}</span>
            {' · '}plugins v{info.pluginsVersion}
            {' · '}{info.enabledModuleCount}/{info.moduleCount} modules enabled
          </Row>
        )}
        {info?.vendor && (
          <Row name="Vendor">
            {vendorHref ? <a href={vendorHref} target="_blank" rel="noopener noreferrer">{info.vendor}</a> : info.vendor}
          </Row>
        )}
        {info?.artifact && <Row name="Artifact"><span class="rab-n-card-mono">{info.artifact}</span></Row>}
        {dates.length > 0 && (
          <Row name="Plugin times">
            <span class="rab-n-card-note">
              {dates.map(([k, d], i) => (
                <span key={k}>{i > 0 ? ' · ' : ''}{k}: {formatIsoTime(d)}</span>
              ))}
            </span>
          </Row>
        )}
        <Row name="REST module">
          <span class="rab-n-card-mono">{module.id}</span>
          <div class="rab-n-card-note">
            /rest/{module.path} · {plural(module.opCount, 'operation')}
            {sourceLabel(module.source) ? ` · ${sourceLabel(module.source)}` : ''}
          </div>
        </Row>
        {info && info.dependsOn.length > 0 && (
          <Row name="Depends on">
            <span class="rab-n-card-mono">
              {info.dependsOn.slice(0, 4).join(', ')}
              {info.dependsOn.length > 4 && ` +${info.dependsOn.length - 4}`}
            </span>
          </Row>
        )}
        {info?.bundle && (
          <>
            <Row name="OSGi bundle">
              <span class="rab-n-card-mono">#{info.bundle.id} {info.bundle.symbolicName} {info.bundle.version}</span>
              <div class="rab-n-card-note">
                <span class={info.bundle.state === 'ACTIVE' ? 'rab-n-java-ok' : 'rab-n-java-deprecated'}>{info.bundle.state}</span>
                {info.bundle.fragment ? ' · fragment' : ''}
                {info.bundle.importCount !== undefined && ` · ${info.bundle.importCount} imp / ${info.bundle.exportCount ?? 0} exp`}
              </div>
            </Row>
            {info.bundle.lastModified > 0 && (
              <Row name="Bundle modified">{formatIsoTime(info.bundle.lastModified)}</Row>
            )}
            {info.bundle.headers['Atlassian-Build-Date'] && (
              <Row name="Build date">{info.bundle.headers['Atlassian-Build-Date']}</Row>
            )}
            {info.bundle.headers['Build-Jdk-Spec'] && (
              <Row name="Build JDK">{info.bundle.headers['Build-Jdk-Spec']}</Row>
            )}
            <Row name="Location"><span class="rab-n-card-mono">{info.bundle.location}</span></Row>
          </>
        )}
      </dl>
    </div>
  );

  return (
    <RichTip tip={tip} testId="app-lozenge-tip" clickPin onOpen={load} className="rab-n-app-tip-wrap">
      <span class="rab-n-tag rab-n-tag-app" data-testid="app-lozenge">App: {module.plugin.name}</span>
    </RichTip>
  );
}

function Row({ name, children }: { name: string; children: ComponentChildren }) {
  return (
    <>
      <dt>{name}</dt>
      <dd>{children}</dd>
    </>
  );
}
