import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import {
  DetailsError, fetchDetails, forgetDetails, isError, shortJava,
  type BundleInfo, type JavaClass, type JavaMethod, type OperationDetails, type PluginInfo, type RestModuleInfo, type Section,
} from '../core/details';
import { annotationTokens, tokenize, type Token } from '../core/javatokens';
import { CopyButton } from './bits';

type Page = 'method' | 'class' | 'types' | 'bundle' | 'imports' | 'exports' | 'plugin' | 'modules' | 'rest';
/** The page last looked at, kept while the page is open: the next operation opens on it too. */
let lastPage: Page = 'method';

/**
 * The Java behind an operation, for system administrators: the method that handles it, its class, the types of its
 * signature, the OSGi bundle with its wiring, the plugin and the REST module, one page each, chosen in a menu on the
 * left. Fetched when the tab opens, once per page load.
 */
export function JavaTab({ baseUrl, opKey }: { baseUrl: string; opKey: string }) {
  const [details, setDetails] = useState<OperationDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [reload, setReload] = useState(0);
  const [page, setPageState] = useState<Page>(lastPage);
  const setPage = (p: Page) => {
    lastPage = p;
    setPageState(p);
  };
  useEffect(() => {
    let live = true;
    setDetails(null);
    setError(null);
    fetchDetails(baseUrl, opKey).then(
      (d) => live && setDetails(d),
      (e) => live && setError(describe(e)),
    );
    return () => {
      live = false;
    };
  }, [baseUrl, opKey, reload]);

  if (error) return <div class="rab-n-pad rab-n-java-error" data-testid="java-error">{error}</div>;
  if (!details) {
    return (
      <div class="rab-n-pad rab-n-subtle" data-testid="java-loading">
        <span class="rab-n-spinner" aria-hidden="true" /> Reading the Java behind this operation…
      </div>
    );
  }
  const n = (s: string) => (full ? s : shortJava(s));
  const method = isError(details.method) ? null : details.method;
  const cls = isError(details.resourceClass) ? null : details.resourceClass;
  const bundle = isError(details.bundle) || 'none' in details.bundle ? null : details.bundle;
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
  const onNavKey = (e: KeyboardEvent) => {
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
          <button key={p.id} role="tab" aria-selected={p.id === current} tabIndex={p.id === current ? 0 : -1}
                  class={'rab-n-java-nav-item' + (p.id === current ? ' on' : '')} onClick={() => setPage(p.id)}
                  data-testid={'java-nav-' + p.id}>
            <span>{p.label}</span>
            {p.failed ? <span class="rab-n-java-nav-failed" title="Could not be read">!</span>
              : p.count !== undefined && <span class="rab-n-java-nav-count">{p.count.toLocaleString()}</span>}
          </button>
        ))}
      </nav>
      <div class="rab-n-java-page" role="tabpanel">
        <div class="rab-n-java-tools">
          <label class="rab-n-java-toggle">
            <input type="checkbox" checked={full} onChange={(e) => setFull((e.target as HTMLInputElement).checked)} /> Full names
          </label>
          {cls && <CopyButton label="Copy class" text={() => cls.name} />}
          {method && <CopyButton label="Copy method" text={() => `${method.class}#${method.name}`} />}
          <button class="rab-n-button" onClick={() => { forgetDetails(opKey); setReload((r) => r + 1); }} title="Read it again from the server">
            Reload
          </button>
        </div>
        {current === 'method' && (
          <Block title="Method" testId="java-method" section={details.method}>
            {(m) => (
              <>
                <MethodCode m={m} n={n} />
                <dl class="rab-n-java-facts">
                  <Fact name="Declared in"><Code tokens={tokenize(n(m.class))} /></Fact>
                  {details.definition && !isError(details.definition) && (
                    <Fact name="Annotated in"><Code tokens={tokenize(n(details.definition.class))} />.{details.definition.name}</Fact>
                  )}
                  {!isError(details.locators) && details.locators.length > 0 && (
                    <Fact name="Reached through">
                      {details.locators.map((l, i) => (
                        <span key={i}>{i > 0 && ' → '}<code><Code tokens={tokenize(n(l.class))} />.{l.name}()</code></span>
                      ))}
                      {' → '}<code><Code tokens={tokenize(n(m.class))} />.{m.name}()</code>
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
            <Block title="Class" testId="java-class" section={details.resourceClass}>{(c) => <ClassFacts c={c} n={n} />}</Block>
            {details.declaringClass && (
              <Block title="Declaring class" section={details.declaringClass}>{(c) => <ClassFacts c={c} n={n} />}</Block>
            )}
          </>
        )}
        {current === 'types' && (
          <Block title="Types in the signature" testId="java-types" section={details.types}>
            {(types) => (
              <Filtered rows={types} text={(t) => t.name + ' ' + t.from} head={['Type', 'From']}
                        row={(t) => [<code><Code tokens={tokenize(n(t.name))} /></code>, <span class="rab-n-subtle">{t.from}</span>]} />
            )}
          </Block>
        )}
        {current === 'bundle' && (
          <Block title="OSGi bundle" testId="java-bundle" section={details.bundle}>
            {(b) => ('none' in b ? <div class="rab-n-subtle">Not in an OSGi bundle: {b.none}.</div> : <BundleFacts b={b} />)}
          </Block>
        )}
        {current === 'imports' && bundle?.imports && (
          <Block title={`Imported packages (${bundle.importCount}) and the bundles that provide them`} testId="java-imports" section={bundle}>
            {(b) => (
              <Filtered rows={b.imports!} total={b.importCount} text={(i) => `${i.package} ${i.from}`} head={['Package', 'Version', 'From']}
                        row={(i) => [<code>{i.package}</code>, <span class="rab-n-subtle">{i.version}</span>, <span>{i.from}</span>]} />
            )}
          </Block>
        )}
        {current === 'exports' && bundle?.exports && (
          <Block title={`Exported packages (${bundle.exportCount}) and how many bundles use them`} section={bundle}>
            {(b) => (
              <Filtered rows={b.exports!} total={b.exportCount} text={(e) => e.package} head={['Package', 'Version', 'Used by']}
                        row={(e) => [<code>{e.package}</code>, <span class="rab-n-subtle">{e.version}</span>, <span>{e.users} bundles</span>]} />
            )}
          </Block>
        )}
        {current === 'plugin' && (
          <Block title="Plugin" testId="java-plugin" section={details.plugin}>
            {(p) => (p ? <PluginFacts p={p} /> : <div class="rab-n-subtle">Unknown.</div>)}
          </Block>
        )}
        {current === 'modules' && plugin && (
          <Block title={`The plugin's modules (${plugin.moduleCount})`} testId="java-modules" section={plugin}>
            {(p) => (
              <Filtered rows={p.modules} total={p.moduleCount} text={(m) => `${m.key} ${m.type} ${m.name ?? ''}`} head={['Key', 'Type', 'State']}
                        row={(m) => [<code>{m.key}</code>, <span class="rab-n-subtle">{m.type}</span>,
                                     <span class={m.enabled ? 'rab-n-java-ok' : 'rab-n-java-deprecated'}>{m.enabled ? 'enabled' : 'disabled'}</span>]} />
            )}
          </Block>
        )}
        {current === 'rest' && <Block title="REST module" testId="java-rest" section={details.module}>{(r) => <ModuleFacts r={r} />}</Block>}
      </div>
    </div>
  );
}

function describe(e: unknown): string {
  if (e instanceof DetailsError) {
    if (e.status === 403) return 'Only system administrators see the Java behind an operation.';
    if (e.reason === 'unknown-operation') return 'This operation is not in the module any more: the catalog may be out of date. Rebuild it from the menu.';
    if (e.reason === 'not-described') return 'This module is not read from Jersey, so its Java is unknown.';
    return `The server could not read it (${e.reason}).`;
  }
  return 'The request failed: ' + (e instanceof Error ? e.message : String(e));
}

/** Coloured Java tokens: annotations, members, types, keywords, strings, numbers and punctuation. */
function Code({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((t, i) => (t.kind === 'space' || t.kind === 'name' ? t.text : <span key={i} class={'rab-n-jc-' + t.kind}>{t.text}</span>))}
    </>
  );
}

function Block<T>({ title, section, testId, children }: {
  title: string; section: Section<T>; testId?: string; children: (value: T) => ComponentChildren;
}) {
  return (
    <section class="rab-n-java-block" data-testid={testId}>
      <h3 class="rab-n-java-title">{title}</h3>
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
               onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
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

/** The method as Java source would show it: its annotations laid out and coloured, then the declaration. */
function MethodCode({ m, n }: { m: JavaMethod; n: (s: string) => string }) {
  return (
    <pre class="rab-n-java-code" data-testid="java-signature">
      {m.annotations.map((a, i) => <div key={i}><Code tokens={annotationTokens(n(a))} /></div>)}
      <Code tokens={tokenize(m.modifiers)} />{m.modifiers && ' '}
      <Code tokens={tokenize(n(m.returns))} /> <span class="rab-n-jc-method">{m.name}</span>
      <span class="rab-n-jc-punct">(</span>
      {m.parameters.map((p, i) => (
        <div key={i} class="rab-n-jc-param">
          {p.annotations.map((a, k) => <span key={k}><Code tokens={annotationTokens(n(a), 60)} /> </span>)}
          <Code tokens={tokenize(n(p.type))} />{' '}
          <span class={p.name ? 'rab-n-jc-pname' : 'rab-n-jc-pname rab-n-subtle'}>{p.name ?? 'arg' + i}</span>
          {i < m.parameters.length - 1 && <span class="rab-n-jc-punct">,</span>}
        </div>
      ))}
      <span class="rab-n-jc-punct">)</span>
      {m.throws.length > 0 && <> <span class="rab-n-jc-kw">throws</span> <Code tokens={tokenize(m.throws.map(n).join(', '))} /></>}
    </pre>
  );
}

function ClassFacts({ c, n }: { c: JavaClass; n: (s: string) => string }) {
  return (
    <dl class="rab-n-java-facts">
      <Fact name="Name"><code>{c.name}</code></Fact>
      <Fact name="Kind"><Code tokens={tokenize([c.modifiers, c.kind].filter(Boolean).join(' '))} /></Fact>
      {c.superclasses.length > 0 && (
        <Fact name="Extends">{c.superclasses.map((s, i) => <span key={i}>{i > 0 && ' → '}<code><Code tokens={tokenize(n(s))} /></code></span>)}</Fact>
      )}
      {c.interfaces.length > 0 && <Fact name="Implements"><CodeList items={c.interfaces.map(n)} /></Fact>}
      {c.annotations.length > 0 && (
        <Fact name="Annotations">
          <pre class="rab-n-java-code rab-n-java-code-small">
            {c.annotations.map((a, i) => <div key={i}><Code tokens={annotationTokens(n(a))} /></div>)}
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
      {b.importCount !== undefined && <Fact name="Wiring">{b.importCount} imported packages, {b.exportCount} exported</Fact>}
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
          {p.vendorUrl ? <a href={p.vendorUrl} target="_blank" rel="noopener noreferrer">{p.vendor}</a> : p.vendor}
        </Fact>
      )}
      {p.description && <Fact name="Description">{p.description}</Fact>}
      <Fact name="Origin and state">{originLabel(p.origin)} · {p.state} · plugins framework v{p.pluginsVersion}</Fact>
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

function originLabel(origin: string): string {
  return origin === 'product' ? 'The product' : origin === 'bundled' ? 'Bundled with the product' : 'Installed app';
}
