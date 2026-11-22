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
  // the input shows every key at once; the search runs 120 ms after the last one
  const [typed, setTyped] = useState(p.query);
  const typing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(typing.current), []);
  const onType = (v: string) => {
    setTyped(v);
    clearTimeout(typing.current);
    typing.current = setTimeout(() => p.onQuery(v), 120);
  };
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

  // the keyboard's position in the list, by row identity, so a list that changes (a module expanded, a new search)
  // does not move it; it follows the selection only when the selection changes
  const [activeId, setActiveId] = useState<string | undefined>(p.selectedKey);
  useEffect(() => setActiveId(p.selectedKey), [p.selectedKey]);
  const idOf = (l: Line) => (l.kind === 'op' ? l.op.key : 'module:' + l.module.id);
  const active = useMemo(() => (activeId ? lines.findIndex((l) => idOf(l) === activeId) : -1), [lines, activeId]);
  const setActive = (i: number) => {
    const l = lines[i];
    if (l) setActiveId(idOf(l));
  };

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

  // keys for the list, from the search box or the list itself; the filter buttons keep their own Enter
  const onListKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const inSearch = target === input.current;
    const inList = !!target.closest?.('.rab-n-vlist');
    if (!lines.length || (!inSearch && !inList)) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const from = active < 0 ? (step > 0 ? -1 : lines.length) : active;
      setActive(Math.min(lines.length - 1, Math.max(0, from + step)));
      if (inList) {
        // keep the keyboard focus on the highlighted row (the list scrolls it into view and renders it first)
        const list = target.closest('.rab-n-vlist');
        requestAnimationFrame(() => (list?.querySelector('.rab-n-op.active, .rab-n-module.active') as HTMLElement | null)?.focus());
      }
    } else if (e.key === 'Enter' && inSearch && active >= 0 && active < lines.length) {
      e.preventDefault();
      const l = lines[active];
      if (l.kind === 'op') p.onSelect(l.op);
      else toggle(l.module.id);
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && inList && active >= 0 && active < lines.length) {
      const l = lines[active];
      if (l.kind === 'module' && p.collapsed.has(l.module.id) === (e.key === 'ArrowRight')) toggle(l.module.id);
    }
  };

  const total = p.rows.length;
  const s = p.summary;
  return (
    <div class="rab-n-sidebar" onKeyDown={onListKey}>
      <div class="rab-n-sidebar-head">
        <div class="rab-n-search-wrap">
          <svg class="rab-n-svg rab-n-search-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.75" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.6 10.6L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={input}
            class="rab-n-search"
            type="search"
            placeholder="Search operations"
            value={typed}
            onInput={(e) => onType((e.target as HTMLInputElement).value)}
            aria-label="Search operations"
            data-testid="search"
          />
          {!typed && <kbd class="rab-n-search-kbd" aria-hidden="true">/</kbd>}
        </div>
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
          <span class="rab-n-status-text">
            {p.loadError ? (
              <span class="rab-n-error">{p.loadError}</span>
            ) : !s ? (
              <>
                <span class="rab-n-spinner" aria-hidden="true" /> Loading the catalog…
              </>
            ) : !s.complete ? (
              <>
                <span class="rab-n-spinner" aria-hidden="true" /> Indexing {s.progress.done} of {s.progress.total} modules… {total.toLocaleString()} operations so far
              </>
            ) : searching || p.supportedOnly || p.methods.length ? (
              <>{hits.length.toLocaleString()} of {total.toLocaleString()} operations</>
            ) : (
              <>{total.toLocaleString()} operations in {s.modules.length} modules</>
            )}
          </span>
          {p.onRefresh && (
            <button class="rab-n-link" onClick={p.onRefresh} title="Rebuild the catalog (system administrators)">
              Refresh
            </button>
          )}
        </div>
      </div>
      {lines.length === 0 && s ? (
        <div class="rab-n-empty" data-testid="no-results">
          <span class="rab-n-empty-icon" aria-hidden="true">
            <svg class="rab-n-svg" width="18" height="18" viewBox="0 0 16 16" fill="none">
              <circle cx="7" cy="7" r="4.75" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10.6 10.6L14 14M5.2 7h3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </span>
          <span>No operation matches.</span>
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
