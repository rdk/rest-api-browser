import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import {
  DetailsError, fetchDetails, fetchSource, forgetDetails, forgetSource, isError, peekDetails, shortJava,
  type BundleInfo, type DecompilerId, type JavaClass, type JavaMethod, type OperationDetails,
  type OperationSource, type PluginInfo, type RestModuleInfo, type Section,
} from '../core/details';
import { annotationTokens, toLines, tokenize, type Token } from '../core/javatokens';
import type { OpenTabRequest } from '../core/sourcetabs';
import { CopyButton, plural, safeHref } from './bits';
import { DecompilerLink, DecompilerToggle, describeSourceError, SourceCode } from './SourceDialog';
import { JavaTypeButton, JavaTypeExpr } from './ClassTip';
import { originLabel } from './facts';
import type { Module } from '../core/types';

type Page = 'method' | 'class' | 'types' | 'bundle' | 'imports' | 'exports' | 'plugin' | 'modules' | 'rest';
/** The page last looked at, kept while the page is open: the next operation opens on it too. */
let lastPage: Page = 'method';

/**
 * The Java behind an operation, for system administrators: the method that handles it, its class, the types of its
 * signature, the OSGi bundle with its wiring, the plugin and the REST module, one page each, chosen in a menu on the
 * left. Fetched when the tab opens, once per page load.
 */
export function JavaTab({ baseUrl, opKey, revision, decompiler, onDecompiler, onOpenClass }: {
  baseUrl: string;
  opKey: string;
  revision?: string;
  decompiler: DecompilerId;
  onDecompiler: (d: DecompilerId) => void;
  onOpenClass?: (req: OpenTabRequest) => void;
}) {
  const [details, setDetails] = useState<OperationDetails | null>(() => peekDetails(opKey));
  const [error, setError] = useState<string | null>(null);
  const [showSpinner, setShowSpinner] = useState(false);
  const [full, setFull] = useState(false);
  const [reload, setReload] = useState(0);
  const [page, setPageState] = useState<Page>(lastPage);
  const setPage = (p: Page) => {
    lastPage = p;
    setPageState(p);
  };
  const openClass = (req: OpenTabRequest) => onOpenClass?.(req);
  // every page opens at its top
  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pageRef.current) pageRef.current.scrollTop = 0;
  }, [page, opKey]);
  useEffect(() => {
    const cached = peekDetails(opKey);
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
          setError(describe(e));
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
    forgetDetails(opKey);
    setReload((r) => r + 1);
  };
  const reloadButton = (label: string) => (
    <button class="rab-n-quiet" onClick={again} title="Read it again from the server">
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
    // Keep the stable two-column shell and delay the spinner by 150 ms so switching to Java never flashes
    const placeholderPages: { id: Page; label: string }[] = [
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
  const pages: { id: Page; label: string; count?: number; failed?: boolean; hidden?: boolean }[] = [
    { id: 'method', label: 'Method', failed: isError(details.method) },
    { id: 'class', label: 'Class', failed: isError(details.resourceClass) },
    { id: 'types', label: 'Types', count: isError(details.types) ? undefined : details.types.length, failed: isError(details.types) },
    { id: 'bundle', label: 'Bundle', failed: isError(details.bundle) },
    { id: 'imports', label: 'Imports', count: bundle?.importCount, hidden: !bundle?.imports },
    { id: 'exports', label: 'Exports', count: bundle?.exportCount, hidden: !bundle?.exports },
    { id: 'plugin', label: 'Plugin', failed: isError(details.plugin) },
    { id: 'modules', label: 'Modules', count: plugin?.moduleCount, hidden: !plugin },
    { id: 'rest', label: 'REST module', failed: isError(details.module) },
  ];
  const shown = pages.filter((p) => !p.hidden);
  const current = shown.some((p) => p.id === page) ? page : 'method';
  const tools = (
    <span class="rab-n-java-tools">
      {(current === 'method' || current === 'class' || current === 'types') && (
        <label class="rab-n-java-toggle" title="Show class names with their packages">
          <input type="checkbox" checked={full} onChange={(e) => setFull((e.target as HTMLInputElement).checked)} /> Full names
        </label>
      )}
      {cls && <CopyButton quiet label="Copy class" text={() => cls.name} />}
      {method && <CopyButton quiet label="Copy method" text={() => `${method.class}#${method.name}`} />}
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
                  data-testid={'java-nav-' + p.id}>
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
                <SourceBlock
                  key={opKey + ':method:' + reload}
                  baseUrl={baseUrl}
                  opKey={opKey}
                  className={m.class}
                  bundleId={bundle?.id}
                  focusMethod={m.name}
                  focusParamCount={m.parameters.length}
                  decompiler={decompiler}
                  onDecompiler={onDecompiler}
                  onOpenClass={openClass}
                />
                <MethodCode m={m} full={full} n={n} bundleId={bundle?.id} opKey={opKey} onOpenClass={onOpenClass} />
                <dl class="rab-n-java-facts">
                  <Fact name="Declared in">
                    <code>
                      <JavaTypeButton fqcn={m.class} fromBundle={bundle?.id} opKey={opKey} onOpenClass={openClass}>
                        <Code tokens={tokenize(n(m.class))} />
                      </JavaTypeButton>
                    </code>
                  </Fact>
                  {details.definition && !isError(details.definition) && (
                    <Fact name="Annotated in">
                      <code>
                        <JavaTypeButton fqcn={details.definition.class} fromBundle={bundle?.id} opKey={opKey} onOpenClass={openClass}>
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
                            <JavaTypeButton fqcn={l.class} fromBundle={bundle?.id} opKey={opKey} onOpenClass={openClass}>
                              <Code tokens={tokenize(n(l.class))} />
                            </JavaTypeButton>.{l.name}()
                          </code>
                        </span>
                      ))}
                      {' → '}
                      <code>
                        <JavaTypeButton fqcn={m.class} fromBundle={bundle?.id} opKey={opKey} onOpenClass={openClass}>
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
                  <div class="rab-n-source-actions rab-n-source-top">
                    <button
                      type="button"
                      class="rab-n-button"
                      data-testid="load-class-source"
                      onClick={() => openClass({
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
                  <ClassFacts c={c} full={full} n={n} bundleId={bundle?.id} opKey={opKey} onOpenClass={onOpenClass} />
                </>
              )}
            </Block>
            {details.declaringClass && (
              <Block title="Declaring class" section={details.declaringClass}>
                {(c) => (
                  <>
                    <div class="rab-n-source-actions rab-n-source-top">
                      <button
                        type="button"
                        class="rab-n-button"
                        onClick={() => openClass({
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
              <Filtered key="types" rows={types} text={(t) => t.name + ' ' + t.from} head={['Type', 'From']}
                        row={(t) => [
                          <JavaTypeButton fqcn={t.name} fromBundle={bundle?.id} opKey={opKey} onOpenClass={openClass}>
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
              <Filtered key="imports" rows={b.imports!} total={b.importCount} text={(i) => `${i.package} ${i.from}`} head={['Package', 'Version', 'From']}
                        row={(i) => [<code>{i.package}</code>, <span class="rab-n-subtle">{i.version}</span>, <span>{i.from}</span>]} />
            )}
          </Block>
        )}
        {current === 'exports' && bundle?.exports && (
          <Block title={`Exported packages (${(bundle.exportCount ?? 0).toLocaleString()}) and how many bundles use them`} testId="java-exports" section={bundle} tools={tools}>
            {(b) => (
              <Filtered key="exports" rows={b.exports!} total={b.exportCount} text={(e) => e.package} head={['Package', 'Version', 'Used by']}
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
              <Filtered key="modules" rows={p.modules} total={p.moduleCount} text={(m) => `${m.key} ${m.type} ${m.name ?? ''}`} head={['Key', 'Type', 'State']}
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

function describe(e: unknown): string {
  if (e instanceof DetailsError) {
    if (e.status === 403 && e.reason === 'decompile-disabled') return 'Decompiling is disabled on this instance (-Drest.api.browser.decompile=false).';
    if (e.status === 403) return 'Only system administrators see the Java behind an operation.';
    if (e.reason === 'unknown-operation') return 'This operation is not in the module any more: the catalog may be out of date. Rebuild it from the menu.';
    if (e.reason === 'not-described') return 'This module is not read from Jersey, so its Java is unknown.';
    if (e.reason === 'class-not-found') return 'The bytecode of this class could not be read (it may be generated at runtime).';
    if (e.reason === 'session-expired') return 'Your session has expired: reload the page to log in again.';
    if (e.reason === 'not-details' || e.reason === 'not-source') return 'The server answered with something other than the details (a proxy or login page?).';
    return `The server could not read it (${e.reason}).`;
  }
  return 'The request failed: ' + (e instanceof Error ? e.message : String(e));
}

/**
 * Top action bar and optional inline method decompiler on the Method page.
 * "Decompile class" always opens the full class in the tabbed SourceDialog focused on this handler method.
 */
function SourceBlock({ baseUrl, opKey, className, bundleId, focusMethod, focusParamCount, decompiler, onDecompiler, onOpenClass }: {
  baseUrl: string;
  opKey: string;
  className: string;
  bundleId?: number;
  focusMethod?: string;
  focusParamCount?: number;
  decompiler: DecompilerId;
  onDecompiler: (d: DecompilerId) => void;
  onOpenClass: (req: OpenTabRequest) => void;
}) {
  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState<OperationSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const query = useMemo(() => ({ op: opKey, scope: 'method' as const, decompiler }), [opKey, decompiler]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setError(null);
    fetchSource(baseUrl, query).then(
      (s) => {
        if (!live) return;
        setSrc(s);
        setLoading(false);
      },
      (e) => {
        if (!live) return;
        setError(describeSourceError(e));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [open, baseUrl, query, attempt]);

  const retry = () => {
    forgetSource(query);
    setSrc(null);
    setAttempt((a) => a + 1);
  };

  const openClassDialog = () => onOpenClass({
    target: src?.class ?? className,
    candidates: [src?.class ?? className],
    fromBundle: src?.bundleId ?? bundleId,
    opKey,
    focusMethod,
    focusParamCount,
  });

  if (!open) {
    return (
      <div class="rab-n-source-actions rab-n-source-top" data-testid="java-source">
        <button type="button" class="rab-n-button" data-testid="load-class-source" onClick={openClassDialog}>
          Decompile class
        </button>
        <button type="button" class="rab-n-button" data-testid="load-source" onClick={() => setOpen(true)}>
          Decompile method
        </button>
      </div>
    );
  }

  return (
    <div class="rab-n-java-source rab-n-source-top" data-testid="java-source">
      <div class="rab-n-java-head">
        <h4 class="rab-n-java-title">Method source</h4>
        {src?.totalLines && (
          <span class="rab-n-subtle">
            {src.totalLines.toLocaleString()} lines
          </span>
        )}
        <span class="rab-n-java-tools">
          <DecompilerLink decompiler={decompiler} label={src?.decompiler} testId="java-source-engine" />
          <DecompilerToggle value={decompiler} onChange={onDecompiler} />
          <button
            type="button"
            class="rab-n-quiet"
            data-testid="load-class-source"
            title="Open the full class in the tabbed decompiler window"
            onClick={openClassDialog}
          >
            Decompile class
          </button>
          {src && <CopyButton quiet label="Copy source" text={() => src.source} />}
          <button type="button" class="rab-n-quiet" onClick={() => setOpen(false)}>Hide</button>
        </span>
      </div>
      {loading ? (
        <div class="rab-n-subtle" role="status">
          <span class="rab-n-spinner" aria-hidden="true" /> Decompiling method with {decompiler === 'vineflower' ? 'Vineflower' : 'CFR'}…
        </div>
      ) : error ? (
        <div class="rab-n-java-error" role="alert">
          {error}{' '}
          <button type="button" class="rab-n-quiet" onClick={retry}>Try again</button>
        </div>
      ) : src ? (
        <SourceCode
          source={src.source}
          className={src.class}
          refs={src.refs}
          bundleId={src.bundleId}
          opKey={opKey}
          onOpenClass={onOpenClass}
          maxAutoHeight={460}
          testId="java-source-code"
        />
      ) : null}
    </div>
  );
}

/**
 * An annotation laid out in lines; its leading `@Annotation` token links to the annotation class when `raw` has a FQCN.
 */
function Annotation({ raw, text, max, bundleId, opKey, onOpenClass }: {
  raw: string; text: string; max?: number; bundleId?: number; opKey?: string; onOpenClass?: (req: OpenTabRequest) => void;
}) {
  const annFqcn = /^@([A-Za-z_][\w$.]*)/.exec(raw)?.[1];
  return (
    <div class="rab-n-jc-ann-block">
      {toLines(annotationTokens(text, max)).map((l, i) => (
        <div key={i} class="rab-n-jc-line" style={{ paddingLeft: l.indent + 4 + 'ch', textIndent: '-4ch' }}>
          <Code
            tokens={l.tokens}
            annFqcn={i === 0 ? annFqcn : undefined}
            bundleId={bundleId}
            opKey={opKey}
            onOpenClass={onOpenClass}
          />
        </div>
      ))}
    </div>
  );
}

/** Coloured Java tokens: annotations, members, types, keywords, strings, numbers and punctuation. */
function Code({ tokens, annFqcn, bundleId, opKey, onOpenClass }: {
  tokens: Token[]; annFqcn?: string; bundleId?: number; opKey?: string; onOpenClass?: (req: OpenTabRequest) => void;
}) {
  let linkedFirstAnn = false;
  return (
    <>
      {tokens.map((t, i) => {
        if (t.kind === 'ann' && annFqcn && onOpenClass && !linkedFirstAnn) {
          linkedFirstAnn = true;
          return (
            <JavaTypeButton key={i} fqcn={annFqcn} fromBundle={bundleId} opKey={opKey} onOpenClass={onOpenClass} kind="ann">
              {t.text}
            </JavaTypeButton>
          );
        }
        return t.kind === 'space' || t.kind === 'name'
          ? t.text
          : <span key={i} class={'rab-n-jc-' + t.kind}>{t.text}</span>;
      })}
    </>
  );
}

function Block<T>({ title, section, testId, tools, children }: {
  title: string; section: Section<T>; testId?: string; tools?: ComponentChildren; children: (value: T) => ComponentChildren;
}) {
  return (
    <section class="rab-n-java-block" data-testid={testId}>
      <div class="rab-n-java-head">
        <h3 class="rab-n-java-title">{title}</h3>
        {tools}
      </div>
      {isError(section) ? <div class="rab-n-java-error">Could not be read: {section.error}</div> : children(section as T)}
    </section>
  );
}

function Fact({ name, children }: { name: string; children: ComponentChildren }) {
  return (
    <>
      <dt>{name}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** A long list with a filter above it. */
function Filtered<T>({ rows, total, text, head, row }: {
  rows: T[]; total?: number; text: (r: T) => string; head: string[]; row: (r: T) => ComponentChildren[];
}) {
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? rows.filter((r) => text(r).toLowerCase().includes(f)) : rows;
  }, [rows, filter]);
  return (
    <>
      <div class="rab-n-java-filter">
        <input class="rab-n-input" type="search" placeholder="Filter" value={filter} aria-label="Filter the list"
               onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
               onKeyDown={(e) => {
                 if (e.key !== 'Escape' || !filter) return;
                 e.preventDefault();
                 e.stopPropagation();
                 setFilter('');
               }} />
        <span class="rab-n-subtle">
          {shown.length === rows.length ? rows.length.toLocaleString() : `${shown.length.toLocaleString()} of ${rows.length.toLocaleString()}`}
          {total !== undefined && total > rows.length && `, ${(total - rows.length).toLocaleString()} more not listed`}
        </span>
      </div>
      <table class="rab-n-java-table">
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>
          {shown.map((r, i) => <tr key={i}>{row(r).map((c, k) => <td key={k}>{c}</td>)}</tr>)}
        </tbody>
      </table>
    </>
  );
}

/** The method as Java source would show it: annotations, return type, parameter types and throws are all clickable. */
function MethodCode({ m, full, n, bundleId, opKey, onOpenClass }: {
  m: JavaMethod; full: boolean; n: (s: string) => string; bundleId?: number; opKey: string; onOpenClass?: (req: OpenTabRequest) => void;
}) {
  return (
    <pre class="rab-n-java-code" data-testid="java-signature">
      {m.annotations.map((a, i) => (
        <Annotation key={i} raw={a} text={n(a)} bundleId={bundleId} opKey={opKey} onOpenClass={onOpenClass} />
      ))}
      <Code tokens={tokenize(m.modifiers)} />{m.modifiers && ' '}
      <JavaTypeExpr typeExpr={m.returns} full={full} fromBundle={bundleId} opKey={opKey} onOpenClass={onOpenClass} />{' '}
      <span class="rab-n-jc-method">{m.name}</span>
      <span class="rab-n-jc-punct">(</span>
      {m.parameters.map((p, i) => (
        <div key={i} class="rab-n-jc-param">
          {p.annotations.map((a, k) => {
            const annFqcn = /^@([A-Za-z_][\w$.]*)/.exec(a)?.[1];
            return (
              <span key={k}>
                <Code tokens={annotationTokens(n(a), 60)} annFqcn={annFqcn} bundleId={bundleId} opKey={opKey} onOpenClass={onOpenClass} />{' '}
              </span>
            );
          })}
          <JavaTypeExpr typeExpr={p.type} full={full} fromBundle={bundleId} opKey={opKey} onOpenClass={onOpenClass} />{' '}
          <span class={p.name ? 'rab-n-jc-pname' : 'rab-n-jc-pname rab-n-subtle'}>{p.name ?? 'arg' + i}</span>
          {i < m.parameters.length - 1 && <span class="rab-n-jc-punct">,</span>}
        </div>
      ))}
      <span class="rab-n-jc-punct">)</span>
      {m.throws.length > 0 && (
        <>
          {' '}<span class="rab-n-jc-kw">throws</span>{' '}
          {m.throws.map((t, i) => (
            <span key={i}>
              {i > 0 && ', '}
              <JavaTypeExpr typeExpr={t} full={full} fromBundle={bundleId} opKey={opKey} onOpenClass={onOpenClass} />
            </span>
          ))}
        </>
      )}
    </pre>
  );
}

function ClassFacts({ c, full, n, bundleId, opKey, onOpenClass }: {
  c: JavaClass; full: boolean; n: (s: string) => string; bundleId?: number; opKey: string; onOpenClass?: (req: OpenTabRequest) => void;
}) {
  return (
    <dl class="rab-n-java-facts">
      <Fact name="Name">
        <code>
          {onOpenClass
            ? <JavaTypeButton fqcn={c.name} fromBundle={bundleId} opKey={opKey} onOpenClass={onOpenClass}>{c.name}</JavaTypeButton>
            : c.name}
        </code>
      </Fact>
      <Fact name="Kind"><Code tokens={tokenize([c.modifiers, c.kind].filter(Boolean).join(' '))} /></Fact>
      {c.superclasses.length > 0 && (
        <Fact name="Extends">
          {c.superclasses.map((s, i) => (
            <span key={i}>
              {i > 0 && ' → '}
              <code><JavaTypeExpr typeExpr={s} full={full} fromBundle={bundleId} opKey={opKey} onOpenClass={onOpenClass} /></code>
            </span>
          ))}
        </Fact>
      )}
      {c.interfaces.length > 0 && (
        <Fact name="Implements">
          <ul class="rab-n-java-list">
            {c.interfaces.map((s, i) => (
              <li key={i}>
                <code><JavaTypeExpr typeExpr={s} full={full} fromBundle={bundleId} opKey={opKey} onOpenClass={onOpenClass} /></code>
              </li>
            ))}
          </ul>
        </Fact>
      )}
      {c.annotations.length > 0 && (
        <Fact name="Annotations">
          <pre class="rab-n-java-code rab-n-java-code-small">
            {c.annotations.map((a, i) => (
              <Annotation key={i} raw={a} text={n(a)} max={70} bundleId={bundleId} opKey={opKey} onOpenClass={onOpenClass} />
            ))}
          </pre>
        </Fact>
      )}
      <Fact name="Package">
        <code>{c.package}</code>
        {c.packageAnnotations.length > 0 && <CodeList items={c.packageAnnotations.map(n)} />}
      </Fact>
      {c.codeSource && <Fact name="Loaded from"><code class="rab-n-java-wrap">{c.codeSource}</code></Fact>}
      <Fact name="Class loader"><code class="rab-n-java-wrap">{c.classLoader}</code></Fact>
    </dl>
  );
}

function BundleFacts({ b }: { b: BundleInfo }) {
  return (
    <dl class="rab-n-java-facts">
      <Fact name="Symbolic name"><code>{b.symbolicName}</code></Fact>
      <Fact name="Version">{b.version}</Fact>
      <Fact name="Id and state">{b.id} · <span class={b.state === 'ACTIVE' ? 'rab-n-java-ok' : 'rab-n-java-deprecated'}>{b.state}</span></Fact>
      <Fact name="Location"><code class="rab-n-java-wrap">{b.location}</code></Fact>
      {b.lastModified > 0 && <Fact name="Last modified">{new Date(b.lastModified).toLocaleString()}</Fact>}
      {b.importCount !== undefined && <Fact name="Wiring">{plural(b.importCount, 'imported package')}, {b.exportCount ?? 0} exported</Fact>}
      {Object.entries(b.headers).map(([k, v]) => <Fact key={k} name={k}><span class="rab-n-java-wrap">{v}</span></Fact>)}
    </dl>
  );
}

function PluginFacts({ p }: { p: PluginInfo }) {
  const dates = [['Installed', p.installed], ['Loaded', p.loaded], ['Enabled', p.enabled]].filter(([, d]) => d) as [string, string][];
  return (
    <dl class="rab-n-java-facts">
      <Fact name="Name">{p.name}</Fact>
      <Fact name="Key"><code>{p.key}</code></Fact>
      {p.version && <Fact name="Version">{p.version}</Fact>}
      {p.vendor && (
        <Fact name="Vendor">
          {safeHref(p.vendorUrl) ? <a href={safeHref(p.vendorUrl)} target="_blank" rel="noopener noreferrer">{p.vendor}</a> : p.vendor}
        </Fact>
      )}
      {p.description && <Fact name="Description">{p.description}</Fact>}
      <Fact name="Origin and state">{originLabel({ origin: p.origin } as Module)} · {p.state} · plugins framework v{p.pluginsVersion}</Fact>
      {p.artifact && <Fact name="Artifact"><code class="rab-n-java-wrap">{p.artifact}</code></Fact>}
      {dates.map(([k, d]) => <Fact key={k} name={k}>{new Date(d).toLocaleString()}</Fact>)}
      <Fact name="Modules">{p.moduleCount}</Fact>
      {p.dependsOn.length > 0 && <Fact name="Depends on"><CodeList items={p.dependsOn} /></Fact>}
      {p.optionallyDependsOn.length > 0 && <Fact name="Optionally on"><CodeList items={p.optionallyDependsOn} /></Fact>}
    </dl>
  );
}

function ModuleFacts({ r }: { r: RestModuleInfo }) {
  return (
    <dl class="rab-n-java-facts">
      <Fact name="Key"><code>{r.key}</code></Fact>
      <Fact name="Path">/rest/{r.path} <span class="rab-n-subtle">(base {r.basePath}, version {r.version})</span></Fact>
      <Fact name="Kind">{r.rest}</Fact>
      {r.description && <Fact name="Description">{r.description}</Fact>}
      {r.descriptor && <Fact name="Descriptor"><code class="rab-n-java-wrap">{r.descriptor}</code></Fact>}
    </dl>
  );
}

function CodeList({ items }: { items: string[] }) {
  return <ul class="rab-n-java-list">{items.map((s, i) => <li key={i}><code><Code tokens={tokenize(s)} /></code></li>)}</ul>;
}
