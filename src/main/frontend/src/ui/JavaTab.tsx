import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import {
  DetailsError, fetchDetails, forgetDetails, isError, shortJava,
  type BundleInfo, type JavaClass, type JavaMethod, type OperationDetails, type PluginInfo, type RestModuleInfo, type Section,
} from '../core/details';
import { CopyButton } from './bits';

/**
 * The Java behind an operation, for system administrators: the method that handles it, its class, the types of its
 * signature, the OSGi bundle, the plugin and the REST module. Fetched when the tab opens, once per page load.
 */
export function JavaTab({ baseUrl, opKey }: { baseUrl: string; opKey: string }) {
  const [details, setDetails] = useState<OperationDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [reload, setReload] = useState(0);
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
  return (
    <div class="rab-n-java" data-testid="java">
      <div class="rab-n-java-bar">
        <label class="rab-n-java-toggle">
          <input type="checkbox" checked={full} onChange={(e) => setFull((e.target as HTMLInputElement).checked)} /> Full names
        </label>
        <span class="rab-n-spacer" />
        {cls && <CopyButton label="Copy class" text={() => cls.name} />}
        {method && <CopyButton label="Copy method" text={() => `${method.class}#${method.name}`} />}
        <button class="rab-n-button" onClick={() => { forgetDetails(opKey); setReload((r) => r + 1); }} title="Read it again from the server">
          Reload
        </button>
      </div>

      <Block title="Method" testId="java-method" section={details.method}>
        {(m) => (
          <>
            <MethodCode m={m} n={n} />
            <dl class="rab-n-java-facts">
              <Fact name="Declared in">{n(m.class)}</Fact>
              {details.definition && !isError(details.definition) && (
                <Fact name="Annotated in">{n(details.definition.class)}.{details.definition.name}</Fact>
              )}
              {!isError(details.locators) && details.locators.length > 0 && (
                <Fact name="Reached through">
                  {details.locators.map((l, i) => (
                    <span key={i}>{i > 0 && ' → '}<code>{n(l.class)}.{l.name}()</code></span>
                  ))}
                  {' → '}<code>{n(m.class)}.{m.name}()</code>
                </Fact>
              )}
              {m.deprecated && <Fact name="Status"><span class="rab-n-java-deprecated">Deprecated</span></Fact>}
            </dl>
          </>
        )}
      </Block>

      <Block title="Class" testId="java-class" section={details.resourceClass}>
        {(c) => <ClassFacts c={c} n={n} />}
      </Block>
      {details.declaringClass && (
        <Block title="Declaring class" section={details.declaringClass}>{(c) => <ClassFacts c={c} n={n} />}</Block>
      )}

      <Block title="Types in the signature" section={details.types}>
        {(types) => (
          <table class="rab-n-java-table">
            <tbody>
              {types.map((t) => (
                <tr key={t.name}><td><code>{n(t.name)}</code></td><td class="rab-n-subtle">{t.from}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </Block>

      <Block title="OSGi bundle" testId="java-bundle" section={details.bundle}>
        {(b) => ('none' in b ? <div class="rab-n-subtle">Not in an OSGi bundle: {b.none}.</div> : <BundleFacts b={b} />)}
      </Block>

      <Block title="Plugin" testId="java-plugin" section={details.plugin}>
        {(p) => (p ? <PluginFacts p={p} /> : <div class="rab-n-subtle">Unknown.</div>)}
      </Block>

      <Block title="REST module" section={details.module}>{(r) => <ModuleFacts r={r} />}</Block>
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

/** The method as Java source would show it: its annotations, modifiers, types and parameters, one per line. */
function MethodCode({ m, n }: { m: JavaMethod; n: (s: string) => string }) {
  return (
    <pre class="rab-n-java-code" data-testid="java-signature">
      {m.annotations.map((a, i) => <div key={i} class="rab-n-jc-ann">{n(a)}</div>)}
      <span class="rab-n-jc-kw">{m.modifiers}</span>{m.modifiers && ' '}
      <span class="rab-n-jc-type">{n(m.returns)}</span> <span class="rab-n-jc-name">{m.name}</span>(
      {m.parameters.map((p, i) => (
        <div key={i} class="rab-n-jc-param">
          {p.annotations.map((a, k) => <span key={k} class="rab-n-jc-ann">{n(a)} </span>)}
          <span class="rab-n-jc-type">{n(p.type)}</span>{' '}
          <span class={p.name ? '' : 'rab-n-subtle'}>{p.name ?? 'arg' + i}</span>
          {i < m.parameters.length - 1 ? ',' : ''}
        </div>
      ))}
      ){m.throws.length > 0 && <> <span class="rab-n-jc-kw">throws</span> <span class="rab-n-jc-type">{m.throws.map(n).join(', ')}</span></>}
    </pre>
  );
}

function ClassFacts({ c, n }: { c: JavaClass; n: (s: string) => string }) {
  return (
    <dl class="rab-n-java-facts">
      <Fact name="Name"><code>{c.name}</code></Fact>
      <Fact name="Kind">{[c.modifiers, c.kind].filter(Boolean).join(' ')}</Fact>
      {c.superclasses.length > 0 && <Fact name="Extends">{c.superclasses.map(n).join(' → ')}</Fact>}
      {c.interfaces.length > 0 && <Fact name="Implements"><List items={c.interfaces.map(n)} /></Fact>}
      {c.annotations.length > 0 && <Fact name="Annotations"><List items={c.annotations.map(n)} /></Fact>}
      <Fact name="Package">
        <code>{c.package}</code>
        {c.packageAnnotations.length > 0 && <List items={c.packageAnnotations.map(n)} />}
      </Fact>
      {c.codeSource && <Fact name="Loaded from"><code class="rab-n-java-wrap">{c.codeSource}</code></Fact>}
      <Fact name="Class loader"><code class="rab-n-java-wrap">{c.classLoader}</code></Fact>
    </dl>
  );
}

function BundleFacts({ b }: { b: BundleInfo }) {
  return (
    <>
      <dl class="rab-n-java-facts">
        <Fact name="Symbolic name"><code>{b.symbolicName}</code></Fact>
        <Fact name="Version">{b.version}</Fact>
        <Fact name="Id and state">{b.id} · <span class={b.state === 'ACTIVE' ? 'rab-n-java-ok' : 'rab-n-java-deprecated'}>{b.state}</span></Fact>
        <Fact name="Location"><code class="rab-n-java-wrap">{b.location}</code></Fact>
        {b.lastModified > 0 && <Fact name="Last modified">{new Date(b.lastModified).toLocaleString()}</Fact>}
        {Object.entries(b.headers).map(([k, v]) => <Fact key={k} name={k}><span class="rab-n-java-wrap">{v}</span></Fact>)}
      </dl>
      {b.imports && (
        <details class="rab-n-java-more" data-testid="java-imports">
          <summary>Imported packages ({b.importCount}) and the bundles that provide them</summary>
          <table class="rab-n-java-table">
            <tbody>
              {b.imports.map((i) => (
                <tr key={i.package}><td><code>{i.package}</code></td><td class="rab-n-subtle">{i.version}</td><td>{i.from}</td></tr>
              ))}
            </tbody>
          </table>
          {(b.importCount ?? 0) > b.imports.length && <div class="rab-n-subtle">… and {(b.importCount ?? 0) - b.imports.length} more</div>}
        </details>
      )}
      {b.exports && (
        <details class="rab-n-java-more">
          <summary>Exported packages ({b.exportCount}) and how many bundles use them</summary>
          <table class="rab-n-java-table">
            <tbody>
              {b.exports.map((e) => (
                <tr key={e.package}><td><code>{e.package}</code></td><td class="rab-n-subtle">{e.version}</td><td>{e.users} using</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </>
  );
}

function PluginFacts({ p }: { p: PluginInfo }) {
  const dates = [['Installed', p.installed], ['Loaded', p.loaded], ['Enabled', p.enabled]].filter(([, d]) => d) as [string, string][];
  return (
    <>
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
        {p.dependsOn.length > 0 && <Fact name="Depends on"><List items={p.dependsOn} /></Fact>}
        {p.optionallyDependsOn.length > 0 && <Fact name="Optionally on"><List items={p.optionallyDependsOn} /></Fact>}
      </dl>
      <details class="rab-n-java-more" data-testid="java-modules">
        <summary>Modules ({p.moduleCount})</summary>
        <table class="rab-n-java-table">
          <tbody>
            {p.modules.map((m) => (
              <tr key={m.key} class={m.enabled ? '' : 'rab-n-disabled'}>
                <td><code>{m.key}</code></td><td class="rab-n-subtle">{m.type}</td><td>{m.enabled ? 'enabled' : 'disabled'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {p.moduleCount > p.modules.length && <div class="rab-n-subtle">… and {p.moduleCount - p.modules.length} more</div>}
      </details>
    </>
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

function List({ items }: { items: string[] }) {
  return <ul class="rab-n-java-list">{items.map((s, i) => <li key={i}><code>{s}</code></li>)}</ul>;
}

function originLabel(origin: string): string {
  return origin === 'product' ? 'The product' : origin === 'bundled' ? 'Bundled with the product' : 'Installed app';
}
