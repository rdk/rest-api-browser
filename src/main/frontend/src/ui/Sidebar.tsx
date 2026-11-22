import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Module, Operation, Summary } from '../core/types';
import { groupRows, search, type GroupRow, type SearchRow } from '../core/search';
import { VirtualList } from './VirtualList';
import { MethodBadge } from './bits';

const ROW = 28;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OTHER'];

export interface SidebarProps {
  summary: Summary | null;
  rows: SearchRow[];
  selectedKey?: string;
  onSelect: (op: Operation) => void;
  query: string;
  onQuery: (q: string) => void;
  supportedOnly: boolean;
  onSupportedOnly: (v: boolean) => void;
  methods: string[];
  onMethods: (m: string[]) => void;
  collapsed: Set<string>;
  onCollapsed: (c: Set<string>) => void;
  onRefresh?: () => void;
  loadError?: string;
}

type Line = { kind: 'module'; module: Module; count: number } | { kind: 'op'; op: Operation; module?: Module };

export function Sidebar(p: SidebarProps) {
  const searching = p.query.trim().length > 0;
  const modulesById = useMemo(() => new Map((p.summary?.modules ?? []).map((m) => [m.id, m])), [p.summary]);
  const filters = { supportedOnly: p.supportedOnly, methods: p.methods };
  const hits = useMemo(() => search(p.rows, p.query, filters), [p.rows, p.query, p.supportedOnly, p.methods]);
  const lines: Line[] = useMemo(() => {
    if (searching) return hits.map((h) => ({ kind: 'op', op: h.op, module: h.module }) as Line);
    if (!p.summary) return [];
    return groupRows(p.summary, hits, p.collapsed).map((g: GroupRow) =>
      g.kind === 'module' ? g : ({ kind: 'op', op: g.op } as Line),
    );
  }, [hits, searching, p.summary, p.collapsed]);
  const hiddenBySupported = useMemo(
    () => (p.supportedOnly && hits.length === 0 ? search(p.rows, p.query, { methods: p.methods }).length : 0),
    [hits, p.rows, p.query, p.supportedOnly, p.methods],
  );

  const [active, setActive] = useState(-1);
  useEffect(() => {
    const i = lines.findIndex((l) => l.kind === 'op' && l.op.key === p.selectedKey);
    setActive(i);
  }, [lines, p.selectedKey]);

  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const toggle = (id: string) => {
    const next = new Set(p.collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    p.onCollapsed(next);
  };

  const onListKey = (e: KeyboardEvent) => {
    if (!lines.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => Math.min(lines.length - 1, Math.max(0, (a < 0 ? (step > 0 ? -1 : lines.length) : a) + step)));
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      const l = lines[active];
      if (l.kind === 'op') p.onSelect(l.op);
      else toggle(l.module.id);
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && active >= 0) {
      const l = lines[active];
      if (l.kind === 'module' && p.collapsed.has(l.module.id) === (e.key === 'ArrowRight')) toggle(l.module.id);
    }
  };

  const total = p.rows.length;
  const s = p.summary;
  return (
    <div class="rab-n-sidebar" onKeyDown={onListKey}>
      <div class="rab-n-sidebar-head">
        <input
          ref={input}
          class="rab-n-search"
          type="search"
          placeholder="Search operations   /"
          value={p.query}
          onInput={(e) => p.onQuery((e.target as HTMLInputElement).value)}
          aria-label="Search operations"
          data-testid="search"
        />
        <div class="rab-n-filters">
          <button
            class={'rab-n-pill' + (p.supportedOnly ? ' on' : '')}
            aria-pressed={p.supportedOnly}
            onClick={() => p.onSupportedOnly(!p.supportedOnly)}
            data-testid="supported-only"
          >
            Supported only
          </button>
          {METHODS.map((m) => {
            const on = p.methods.includes(m);
            return (
              <button
                key={m}
                class={'rab-n-pill rab-n-pill-' + m.toLowerCase() + (on ? ' on' : '')}
                aria-pressed={on}
                onClick={() => p.onMethods(on ? p.methods.filter((x) => x !== m) : [...p.methods, m])}
              >
                {m === 'OTHER' ? 'Other' : m === 'DELETE' ? 'DEL' : m}
              </button>
            );
          })}
        </div>
        <div class="rab-n-status" data-testid="status">
          {p.loadError ? (
            <span class="rab-n-error">{p.loadError}</span>
          ) : !s ? (
            'Loading the catalog…'
          ) : !s.complete ? (
            <>Indexing {s.progress.done} of {s.progress.total} modules… {total.toLocaleString()} operations so far</>
          ) : searching || p.supportedOnly || p.methods.length ? (
            <>{hits.length.toLocaleString()} of {total.toLocaleString()} operations</>
          ) : (
            <>{total.toLocaleString()} operations in {s.modules.length} modules</>
          )}
          {s?.admin && p.onRefresh && (
            <button class="rab-n-link" onClick={p.onRefresh} title="Rebuild the catalog (system administrators)">
              Refresh
            </button>
          )}
        </div>
      </div>
      {lines.length === 0 && s ? (
        <div class="rab-n-empty" data-testid="no-results">
          No operation matches.
          {hiddenBySupported > 0 && (
            <button class="rab-n-link" onClick={() => p.onSupportedOnly(false)}>
              Include internal and app endpoints ({hiddenBySupported})
            </button>
          )}
        </div>
      ) : (
        <VirtualList
          count={lines.length}
          rowHeight={ROW}
          activeIndex={active}
          ariaLabel="Operations"
          renderRow={(i) => {
            const l = lines[i];
            if (l.kind === 'module') {
              return (
                <ModuleRow
                  module={l.module}
                  count={l.count}
                  collapsed={p.collapsed.has(l.module.id)}
                  active={i === active}
                  onClick={() => {
                    setActive(i);
                    toggle(l.module.id);
                  }}
                />
              );
            }
            const m = l.module ?? modulesById.get(l.op.module);
            return (
              <button
                class={'rab-n-op' + (l.op.key === p.selectedKey ? ' selected' : '') + (i === active ? ' active' : '') + (searching ? '' : ' indented')}
                onClick={() => {
                  setActive(i);
                  p.onSelect(l.op);
                }}
                title={(m ? m.path + '/' : '') + l.op.path}
                data-testid="op"
                data-method={l.op.method}
              >
                <MethodBadge method={l.op.method} />
                <span class="rab-n-op-path">{searching && m ? m.path + '/' + l.op.path : '/' + l.op.path}</span>
                {searching && m && m.stability !== 'internal' && (
                  <span class={'rab-n-tag rab-n-tag-' + m.stability}>{m.stability === 'supported' ? 'Supported' : 'App'}</span>
                )}
                {l.op.deprecated && <span class="rab-n-tag rab-n-tag-deprecated">Deprecated</span>}
              </button>
            );
          }}
        />
      )}
    </div>
  );
}

function ModuleRow({ module, count, collapsed, active, onClick }: {
  module: Module; count: number; collapsed: boolean; active: boolean; onClick: () => void;
}) {
  const origin = module.origin === 'product' ? '' : module.origin === 'bundled' ? 'Bundled: ' : 'App: ';
  return (
    <button
      class={'rab-n-module' + (active ? ' active' : '') + (module.state !== 'ok' ? ' ' + module.state : '')}
      onClick={onClick}
      title={module.plugin.name + (module.error ? '\n' + module.error : '')}
      aria-expanded={!collapsed}
      data-testid="module"
    >
      <span class="rab-n-chevron">{collapsed ? '▸' : '▾'}</span>
      <span class="rab-n-module-path">{origin}{module.path}</span>
      {module.stability === 'supported' && <span class="rab-n-tag rab-n-tag-supported">Supported</span>}
      <span class="rab-n-count">
        {module.state === 'ok' ? count : module.state === 'pending' ? '…' : 'failed: ' + (module.reason ?? 'error')}
      </span>
    </button>
  );
}
