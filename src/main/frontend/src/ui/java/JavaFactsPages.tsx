import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { isError, type BundleInfo, type JavaClass, type PluginInfo, type RestModuleInfo, type Section } from '../../core/details';
import { formatIsoTime } from '../../core/detailserror';
import { tokenize } from '../../lib/java-source';
import type { OpenTabRequest } from '../../core/sourcetabs';
import type { Module } from '../../core/types';
import { plural, safeHref } from '../bits';
import { JavaTypeButton, JavaTypeExpr } from './JavaTypeLinks';
import { originLabel } from '../../core/facts';
import { Annotation, Code, CodeList } from './JavaSignature';

const LARGE_TABLE_THRESHOLD = 200;

export function Block<T>({ title, section, testId, tools, children }: {
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

export function Fact({ name, children }: { name: string; children: ComponentChildren }) {
  return (
    <>
      <dt>{name}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** A filterable table that debounces large sets (>200 rows) and slices initial DOM rows with a "Show all" control. */
export function FilteredTable<T>({ rows, total, text, head, row }: {
  rows: T[]; total?: number; text: (r: T) => string; head: string[]; row: (r: T) => ComponentChildren[];
}) {
  const [typed, setTyped] = useState('');
  const [applied, setApplied] = useState('');
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    setShowAll(false);
  }, [rows, applied]);

  useEffect(() => {
    if (rows.length <= LARGE_TABLE_THRESHOLD || typed === '') {
      setApplied(typed);
      return;
    }
    const timer = setTimeout(() => setApplied(typed), 120);
    return () => clearTimeout(timer);
  }, [typed, rows.length]);

  const shown = useMemo(() => {
    const f = applied.trim().toLowerCase();
    return f ? rows.filter((r) => text(r).toLowerCase().includes(f)) : rows;
  }, [rows, applied]);

  const truncated = !showAll && shown.length > LARGE_TABLE_THRESHOLD;
  const visible = truncated ? shown.slice(0, LARGE_TABLE_THRESHOLD) : shown;

  return (
    <>
      <div class="rab-n-java-filter">
        <input class="rab-n-input" type="search" placeholder="Filter" value={typed} aria-label="Filter the list"
               onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
               onKeyDown={(e) => {
                 if (e.key !== 'Escape' || !typed) return;
                 e.preventDefault();
                 e.stopPropagation();
                 setTyped('');
                 setApplied('');
               }} />
        <span class="rab-n-subtle">
          {shown.length === rows.length ? rows.length.toLocaleString() : `${shown.length.toLocaleString()} of ${rows.length.toLocaleString()}`}
          {total !== undefined && total > rows.length && `, ${(total - rows.length).toLocaleString()} more not listed`}
        </span>
      </div>
      <table class="rab-n-java-table">
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>
          {visible.map((r, i) => <tr key={i}>{row(r).map((c, k) => <td key={k}>{c}</td>)}</tr>)}
        </tbody>
      </table>
      {truncated && (
        <div class="rab-n-pad">
          <button type="button" class="rab-n-link" onClick={() => setShowAll(true)}>
            Show all {shown.length.toLocaleString()} rows (showing first {LARGE_TABLE_THRESHOLD})
          </button>
        </div>
      )}
    </>
  );
}

export function ClassFacts({ c, full, n, bundleId, opKey, onOpenClass }: {
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

export function BundleFacts({ b }: { b: BundleInfo }) {
  return (
    <dl class="rab-n-java-facts">
      <Fact name="Symbolic name"><code>{b.symbolicName}</code></Fact>
      <Fact name="Version">{b.version}</Fact>
      <Fact name="Id and state">{b.id} · <span class={b.state === 'ACTIVE' ? 'rab-n-java-ok' : 'rab-n-java-deprecated'}>{b.state}</span></Fact>
      <Fact name="Location"><code class="rab-n-java-wrap">{b.location}</code></Fact>
      {b.lastModified > 0 && <Fact name="Last modified">{formatIsoTime(b.lastModified)}</Fact>}
      {b.importCount !== undefined && <Fact name="Wiring">{plural(b.importCount, 'imported package')}, {b.exportCount ?? 0} exported</Fact>}
      {Object.entries(b.headers).map(([k, v]) => <Fact key={k} name={k}><span class="rab-n-java-wrap">{v}</span></Fact>)}
    </dl>
  );
}

export function PluginFacts({ p }: { p: PluginInfo }) {
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
      {dates.map(([k, d]) => <Fact key={k} name={k}>{formatIsoTime(d)}</Fact>)}
      <Fact name="Modules">{p.moduleCount}</Fact>
      {p.dependsOn.length > 0 && <Fact name="Depends on"><CodeList items={p.dependsOn} /></Fact>}
      {p.optionallyDependsOn.length > 0 && <Fact name="Optionally on"><CodeList items={p.optionallyDependsOn} /></Fact>}
    </dl>
  );
}

export function ModuleFacts({ r }: { r: RestModuleInfo }) {
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
