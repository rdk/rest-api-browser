import { useEffect, useRef, useState } from 'preact/hooks';
import {
  fetchDetails, forgetDetails, isError, peekDetails, shortJava,
  type DecompilerId, type OperationDetails,
} from '../core/details';
import { describeDetailsError } from '../core/detailserror';
import { tokenize } from '../lib/java-source';
import type { OpenTabRequest } from '../core/sourcetabs';
import { tipProps, type UiTipSpec } from '../core/uitips';
import { CopyButton, plural } from './bits';
import { JavaTypeButton } from './java/JavaTypeLinks';
import { InlineMethodSource } from './java/InlineMethodSource';
import { Block, BundleFacts, ClassFacts, Fact, FilteredTable, ModuleFacts, PluginFacts } from './java/JavaFactsPages';
import { Code, MethodCode } from './java/JavaSignature';

export type JavaPage = 'method' | 'class' | 'types' | 'bundle' | 'imports' | 'exports' | 'plugin' | 'modules' | 'rest';

/**
 * The Java behind an operation, for system administrators: the method that handles it, its class, the types of its
 * signature, the OSGi bundle with its wiring, the plugin and the REST module. Fetched when the tab opens.
 */
export function JavaTab({
  baseUrl, opKey, revision, decompiler, onDecompiler, pretty, onPretty, onOpenClass, page: controlledPage, onPage,
}: {
  baseUrl: string;
  opKey: string;
  revision?: string;
  decompiler: DecompilerId;
  onDecompiler: (d: DecompilerId) => void;
  pretty?: boolean;
  onPretty?: () => void;
  onOpenClass?: (req: OpenTabRequest) => void;
  page?: JavaPage;
  onPage?: (p: JavaPage) => void;
}) {
  const [details, setDetails] = useState<OperationDetails | null>(() => peekDetails(opKey, baseUrl));
  const [error, setError] = useState<string | null>(null);
  const [showSpinner, setShowSpinner] = useState(false);
  const [full, setFull] = useState(false);
  const [reload, setReload] = useState(0);
  const [localPage, setLocalPage] = useState<JavaPage>('method');
  const page = controlledPage ?? localPage;
  const setPage = (p: JavaPage) => {
    setLocalPage(p);
    onPage?.(p);
  };

  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pageRef.current) pageRef.current.scrollTop = 0;
  }, [page, opKey]);

  useEffect(() => {
    const cached = peekDetails(opKey, baseUrl);
    if (cached) {
      setDetails(cached);
      setError(null);
      setShowSpinner(false);
      return;
    }
    let live = true;
    setDetails(null);
    setError(null);
    setShowSpinner(false);
    const timer = setTimeout(() => { if (live) setShowSpinner(true); }, 150);
    fetchDetails(baseUrl, opKey).then(
      (d) => {
        clearTimeout(timer);
        if (live) {
          setDetails(d);
          setShowSpinner(false);
        }
      },
      (e) => {
        clearTimeout(timer);
        if (live) {
          setError(describeDetailsError(e, 'details'));
          setShowSpinner(false);
        }
      },
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [baseUrl, opKey, reload, revision]);

  const again = () => {
    forgetDetails(opKey, baseUrl);
    setReload((r) => r + 1);
  };
  const reloadButton = (label: string) => (
    <button
      class="rab-n-quiet"
      onClick={again}
      {...tipProps({ title: 'Reload Java metadata', body: 'Discard the cached reflection details and fetch fresh information from the server.' })}
    >
      <svg class="rab-n-svg" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M13 8a5 5 0 11-1.5-3.6M13 2.5v3h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label}
    </button>
  );
  if (error) {
    return (
      <div class="rab-n-pad rab-n-java-error" data-testid="java-error" role="alert">
        {error} {reloadButton('Try again')}
      </div>
    );
  }
  if (!details) {
    const placeholderPages: { id: JavaPage; label: string }[] = [
      { id: 'method', label: 'Method' },
      { id: 'class', label: 'Class' },
      { id: 'types', label: 'Types' },
      { id: 'bundle', label: 'Bundle' },
      { id: 'plugin', label: 'Plugin' },
      { id: 'rest', label: 'REST module' },
    ];
    return (
      <div class="rab-n-java" data-testid="java">
        <nav class="rab-n-java-nav" aria-label="The Java behind the operation">
          {placeholderPages.map((p) => (
            <button key={p.id} type="button" class={'rab-n-java-nav-item' + (p.id === page ? ' on' : '')} disabled>
              <span>{p.label}</span>
            </button>
          ))}
        </nav>
        <div class="rab-n-java-page">
          {showSpinner && (
            <div class="rab-n-pad rab-n-subtle" data-testid="java-loading" role="status">
              <span class="rab-n-spinner" aria-hidden="true" /> Reading the Java behind this operation…
            </div>
          )}
        </div>
      </div>
    );
  }

  const n = (s: string) => (full ? s : shortJava(s));
  const method = isError(details.method) ? null : details.method;
  const cls = isError(details.resourceClass) ? null : details.resourceClass;
  const bundle = !details.bundle || isError(details.bundle) || 'none' in details.bundle ? null : details.bundle;
  const plugin = isError(details.plugin) ? null : details.plugin;
  const pages: { id: JavaPage; label: string; tip: UiTipSpec; count?: number; failed?: boolean; hidden?: boolean }[] = [
    { id: 'method', label: 'Method', tip: { title: 'Handler method', body: 'Java signature, JAX-RS/OpenAPI annotations, and inline method decompiler.' }, failed: isError(details.method) },
    { id: 'class', label: 'Class', tip: { title: 'Resource class', body: 'Class declaration, hierarchy, annotations, classloader, and full-class decompiler.' }, failed: isError(details.resourceClass) },
    { id: 'types', label: 'Types', tip: { title: 'Signature types', body: 'All Java classes referenced by parameters, return type, and method annotations.' }, count: isError(details.types) ? undefined : details.types.length, failed: isError(details.types) },
    { id: 'bundle', label: 'Bundle', tip: { title: 'OSGi bundle', body: 'OSGi symbolic name, bundle ID, version, state, and manifest headers.' }, failed: isError(details.bundle) },
    { id: 'imports', label: 'Imports', tip: { title: 'Imported packages', body: 'Java packages imported by this OSGi bundle and which bundles provide them.' }, count: bundle?.importCount, hidden: !bundle?.imports },
    { id: 'exports', label: 'Exports', tip: { title: 'Exported packages', body: 'Java packages exported by this OSGi bundle and how many bundles consume them.' }, count: bundle?.exportCount, hidden: !bundle?.exports },
    { id: 'plugin', label: 'Plugin', tip: { title: 'Atlassian plugin', body: 'Plugin key, version, vendor, origin, and installation state.' }, failed: isError(details.plugin) },
    { id: 'modules', label: 'Modules', tip: { title: 'Plugin modules', body: 'All plugin descriptors (REST, servlets, web-items, etc.) declared by this plugin.' }, count: plugin?.moduleCount, hidden: !plugin },
    { id: 'rest', label: 'REST module', tip: { title: 'REST module', body: 'REST descriptor path, version, API stability, and discovery source.' }, failed: isError(details.module) },
  ];
  const shown = pages.filter((p) => !p.hidden);
  const current = shown.some((p) => p.id === page) ? page : 'method';
  const tools = (
    <span class="rab-n-java-tools">
      {(current === 'method' || current === 'class' || current === 'types') && (
        <label
          class="rab-n-java-toggle"
          {...tipProps({ title: 'Full class names', body: 'Show fully qualified package names for Java types and annotations instead of short names.' })}
        >
          <input type="checkbox" checked={full} onChange={(e) => setFull((e.target as HTMLInputElement).checked)} /> Full names
        </label>
      )}
      {cls && <CopyButton quiet label="Copy class" tip={{ title: 'Copy class name', body: `Copy ${cls.name} to your clipboard.` }} text={() => cls.name} />}
      {method && <CopyButton quiet label="Copy method" tip={{ title: 'Copy method reference', body: `Copy ${method.class}#${method.name} to your clipboard.` }} text={() => `${method.class}#${method.name}`} />}
      {reloadButton('Reload')}
    </span>
  );
  const onNavKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const i = shown.findIndex((p) => p.id === current);
    const next = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? shown.length - 1 : -2;
    if (next === -2) return;
    e.preventDefault();
    const p = shown[(next + shown.length) % shown.length];
    setPage(p.id);
    const nav = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => (nav.querySelector('[aria-selected="true"]') as HTMLElement | null)?.focus());
  };

  return (
    <div class="rab-n-java" data-testid="java">
      <nav class="rab-n-java-nav" role="tablist" aria-orientation="vertical" aria-label="The Java behind the operation" onKeyDown={onNavKey}>
        {shown.map((p) => (
          <button key={p.id} id={'rab-n-java-tab-' + p.id} role="tab" aria-selected={p.id === current} aria-controls="rab-n-java-page"
                  tabIndex={p.id === current ? 0 : -1}
                  class={'rab-n-java-nav-item' + (p.id === current ? ' on' : '')} onClick={() => setPage(p.id)}
                  data-testid={'java-nav-' + p.id}
                  {...tipProps(p.tip)}>
            <span>{p.label}</span>
            {p.failed ? <span class="rab-n-java-nav-failed" title="Could not be read"><span aria-hidden="true">!</span><span class="rab-n-sr"> (could not be read)</span></span>
              : p.count !== undefined && <span class="rab-n-java-nav-count">{p.count.toLocaleString()}</span>}
          </button>
        ))}
      </nav>
      <div ref={pageRef} id="rab-n-java-page" class="rab-n-java-page" role="tabpanel" aria-labelledby={'rab-n-java-tab-' + current} tabIndex={0}>
        {current === 'method' && (
          <Block title="Method" testId="java-method" section={details.method} tools={tools}>
            {(m) => (
              <>
                <InlineMethodSource
                  key={opKey + ':method:' + reload}
                  baseUrl={baseUrl}
                  opKey={opKey}
                  className={m.class}
                  bundleId={bundle?.id}
                  focusMethod={m.name}
                  focusParamCount={m.parameters.length}
                  decompiler={decompiler}
                  onDecompiler={onDecompiler}
                  pretty={!!pretty}
                  onPretty={onPretty}
                  onOpenClass={onOpenClass}
                />
                <MethodCode m={m} full={full} n={n} bundleId={bundle?.id} opKey={opKey} onOpenClass={onOpenClass} />
                <dl class="rab-n-java-facts">
                  <Fact name="Declared in">
                    <code>
                      <JavaTypeButton fqcn={m.class} fromBundle={bundle?.id} opKey={opKey} onOpenClass={onOpenClass}>
                        <Code tokens={tokenize(n(m.class))} />
                      </JavaTypeButton>
                    </code>
                  </Fact>
                  {details.definition && !isError(details.definition) && (
                    <Fact name="Annotated in">
                      <code>
                        <JavaTypeButton fqcn={details.definition.class} fromBundle={bundle?.id} opKey={opKey} onOpenClass={onOpenClass}>
                          <Code tokens={tokenize(n(details.definition.class))} />
                        </JavaTypeButton>
                      </code>.{details.definition.name}
                    </Fact>
                  )}
                  {!isError(details.locators) && details.locators.length > 0 && (
                    <Fact name="Reached through">
                      {details.locators.map((l, i) => (
                        <span key={i}>
                          {i > 0 && ' → '}
                          <code>
                            <JavaTypeButton fqcn={l.class} fromBundle={bundle?.id} opKey={opKey} onOpenClass={onOpenClass}>
                              <Code tokens={tokenize(n(l.class))} />
                            </JavaTypeButton>.{l.name}()
                          </code>
                        </span>
                      ))}
                      {' → '}
                      <code>
                        <JavaTypeButton fqcn={m.class} fromBundle={bundle?.id} opKey={opKey} onOpenClass={onOpenClass}>
                          <Code tokens={tokenize(n(m.class))} />
                        </JavaTypeButton>.{m.name}()
                      </code>
                    </Fact>
                  )}
                  {m.deprecated && <Fact name="Status"><span class="rab-n-java-deprecated">Deprecated</span></Fact>}
                </dl>
              </>
            )}
          </Block>
        )}
        {current === 'class' && (
          <>
            <Block title="Class" testId="java-class" section={details.resourceClass} tools={tools}>
              {(c) => (
                <>
                  {onOpenClass && (
                    <div class="rab-n-source-actions rab-n-source-top">
                      <button
                        type="button"
                        class="rab-n-button"
                        data-testid="load-class-source"
                        {...tipProps({ title: 'Decompile full class', body: 'Decompile the entire resource class in the floating tabbed window, scrolled to this method.' })}
                        onClick={() => onOpenClass({
                          target: c.name,
                          candidates: [c.name],
                          fromBundle: bundle?.id,
                          opKey,
                          focusMethod: method?.name,
                          focusParamCount: method?.parameters.length,
                        })}
                      >
                        Decompile class
                      </button>
                    </div>
                  )}
                  <ClassFacts c={c} full={full} n={n} bundleId={bundle?.id} opKey={opKey} onOpenClass={onOpenClass} />
                </>
              )}
            </Block>
            {details.declaringClass && (
              <Block title="Declaring class" section={details.declaringClass}>
                {(c) => (
                  <>
                    {onOpenClass && (
                      <div class="rab-n-source-actions rab-n-source-top">
                        <button
                          type="button"
                          class="rab-n-button"
                          {...tipProps({ title: 'Decompile declaring class', body: 'Open the full declaring class in the floating tabbed decompiler window.' })}
                          onClick={() => onOpenClass({
                            target: c.name,
                            candidates: [c.name],
                            fromBundle: bundle?.id,
                            opKey,
                            focusMethod: method?.name,
                            focusParamCount: method?.parameters.length,
                          })}
                        >
                          Decompile class
                        </button>
                      </div>
                    )}
                    <ClassFacts c={c} full={full} n={n} bundleId={bundle?.id} opKey={opKey} onOpenClass={onOpenClass} />
                  </>
                )}
              </Block>
            )}
          </>
        )}
        {current === 'types' && (
          <Block title="Types in the signature" testId="java-types" section={details.types} tools={tools}>
            {(types) => (
              <FilteredTable key="types" rows={types} text={(t) => t.name + ' ' + t.from} head={['Type', 'From']}
                             row={(t) => [
                               <JavaTypeButton fqcn={t.name} fromBundle={bundle?.id} opKey={opKey} onOpenClass={onOpenClass}>
                                 <code><Code tokens={tokenize(n(t.name))} /></code>
                               </JavaTypeButton>,
                               <span class="rab-n-subtle">{t.from}</span>,
                             ]} />
            )}
          </Block>
        )}
        {current === 'bundle' && (
          <Block title="OSGi bundle" testId="java-bundle" section={details.bundle} tools={tools}>
            {(b) => ('none' in b ? <div class="rab-n-subtle">Not in an OSGi bundle: {b.none}.</div> : <BundleFacts b={b} />)}
          </Block>
        )}
        {current === 'imports' && bundle?.imports && (
          <Block title={`Imported packages (${(bundle.importCount ?? 0).toLocaleString()}) and the bundles that provide them`} testId="java-imports" section={bundle} tools={tools}>
            {(b) => (
              <FilteredTable key="imports" rows={b.imports!} total={b.importCount} text={(i) => `${i.package} ${i.from}`} head={['Package', 'Version', 'From']}
                             row={(i) => [<code>{i.package}</code>, <span class="rab-n-subtle">{i.version}</span>, <span>{i.from}</span>]} />
            )}
          </Block>
        )}
        {current === 'exports' && bundle?.exports && (
          <Block title={`Exported packages (${(bundle.exportCount ?? 0).toLocaleString()}) and how many bundles use them`} testId="java-exports" section={bundle} tools={tools}>
            {(b) => (
              <FilteredTable key="exports" rows={b.exports!} total={b.exportCount} text={(e) => e.package} head={['Package', 'Version', 'Used by']}
                             row={(e) => [<code>{e.package}</code>, <span class="rab-n-subtle">{e.version}</span>, <span>{plural(e.users, 'bundle')}</span>]} />
            )}
          </Block>
        )}
        {current === 'plugin' && (
          <Block title="Plugin" testId="java-plugin" section={details.plugin} tools={tools}>
            {(p) => (p ? <PluginFacts p={p} /> : <div class="rab-n-subtle">Unknown.</div>)}
          </Block>
        )}
        {current === 'modules' && plugin && (
          <Block title={`The plugin's modules (${plugin.moduleCount.toLocaleString()})`} testId="java-modules" section={plugin} tools={tools}>
            {(p) => (
              <FilteredTable key="modules" rows={p.modules} total={p.moduleCount} text={(m) => `${m.key} ${m.type} ${m.name ?? ''}`} head={['Key', 'Type', 'State']}
                             row={(m) => [<code>{m.key}</code>, <span class="rab-n-subtle">{m.type}</span>,
                                          <span class={m.enabled ? 'rab-n-java-ok' : 'rab-n-java-deprecated'}>{m.enabled ? 'enabled' : 'disabled'}</span>]} />
            )}
          </Block>
        )}
        {current === 'rest' && <Block title="REST module" testId="java-rest" section={details.module} tools={tools}>{(r) => <ModuleFacts r={r} />}</Block>}
      </div>
    </div>
  );
}
