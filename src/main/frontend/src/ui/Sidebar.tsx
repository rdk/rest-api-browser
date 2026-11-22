import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Module, Operation, Summary } from '../core/types';
import { groupRows, search, type GroupRow, type SearchRow } from '../core/search';
import { VirtualList } from './VirtualList';
import { MethodBadge, PathText, usePin } from './bits';
import { searchWords } from '../core/pathparts';
import { moduleFact, rowTicks, type Fact } from './facts';
import { RowCard, type CardTarget } from './RowCard';

const ROW = 24;
/** How long the pointer rests on a row before its card opens; moving on to the next row while one shows is instant. */
const CARD_DELAY = 450;

export interface SidebarProps {
  summary: Summary | null;
  rows: SearchRow[];
  selectedKey?: string;
  onSelect: (op: Operation) => void;
  query: string;
  onQuery: (q: string) => void;
  supportedOnly: boolean;
  onSupportedOnly: (v: boolean) => void;
  collapsed: Set<string>;
  onCollapsed: (c: Set<string>) => void;
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
  const words = useMemo(() => searchWords(p.query), [p.query]);
  const modulesById = useMemo(() => new Map((p.summary?.modules ?? []).map((m) => [m.id, m])), [p.summary]);
  const hits = useMemo(() => search(p.rows, p.query, { supportedOnly: p.supportedOnly }), [p.rows, p.query, p.supportedOnly]);
  const lines: Line[] = useMemo(() => {
    if (searching) return hits.map((h) => ({ kind: 'op', op: h.op, module: h.module }) as Line);
    if (!p.summary) return [];
    return groupRows(p.summary, hits, p.collapsed).map((g: GroupRow) =>
      g.kind === 'module' ? g : ({ kind: 'op', op: g.op } as Line),
    );
  }, [hits, searching, p.summary, p.collapsed]);
  // one small button folds or unfolds every module: unfold when all the listed ones are folded, else fold them all
  const allCollapsed = useMemo(
    () => !searching && lines.length > 0 && lines.every((l) => l.kind !== 'module' || p.collapsed.has(l.module.id)),
    [lines, searching, p.collapsed],
  );
  const toggleAll = () => p.onCollapsed(allCollapsed ? new Set() : new Set((p.summary?.modules ?? []).map((m) => m.id)));
  const hiddenBySupported = useMemo(
    () => (p.supportedOnly && hits.length === 0 ? search(p.rows, p.query).length : 0),
    [hits, p.rows, p.query, p.supportedOnly],
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

  // the hover card of a row, one for the whole list: the rows only carry their index (data-i)
  const [card, setCard] = useState<{ id: string; target: CardTarget; left: number; top: number } | null>(null);
  const cardTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cardFor = useRef<string | undefined>(undefined);
  const cardBox = useRef<HTMLDivElement | null>(null);
  const forceHide = () => {
    clearTimeout(cardTimer.current);
    cardFor.current = undefined;
    setCard(null);
  };
  // Alt+P pins the card: it stays until a click outside it or Escape, whatever the pointer, the list or the focus do
  const shownRef = useRef(false);
  shownRef.current = !!card;
  const pinned = usePin(() => shownRef.current, cardBox, forceHide);
  const pinnedRef = useRef(false);
  pinnedRef.current = pinned;
  const hideCard = () => {
    if (!pinnedRef.current) forceHide();
  };
  useEffect(() => hideCard, []);
  useEffect(() => hideCard(), [lines]);
  const scheduleCard = (row: HTMLElement, delay: number) => {
    const id = row.dataset.id;
    if (!id || cardFor.current === id) return;
    cardFor.current = id;
    clearTimeout(cardTimer.current);
    cardTimer.current = setTimeout(() => {
      const l = lines[Number(row.dataset.i)];
      const root = row.closest('.rab-n') as HTMLElement | null;
      const side = row.closest('.rab-n-sidebar') as HTMLElement | null;
      if (!l || !root || !side || !row.isConnected || idOf(l) !== id) return;
      const rr = root.getBoundingClientRect();
      const target: CardTarget = l.kind === 'op'
        ? { kind: 'op', op: l.op, module: l.module ?? modulesById.get(l.op.module) }
        : { kind: 'module', module: l.module, count: l.count };
      setCard({ id, target, left: side.getBoundingClientRect().right - rr.left + 10, top: row.getBoundingClientRect().top - rr.top });
    }, delay);
  };
  const onListOver = (e: MouseEvent) => {
    if (pinnedRef.current) return;
    const row = (e.target as Element).closest?.('[data-i]') as HTMLElement | null;
    if (row) scheduleCard(row, card ? 0 : CARD_DELAY);
  };
  // a click closes the card, and it stays closed until the pointer moves on to another row
  const onListDown = (e: MouseEvent) => {
    hideCard();
    cardFor.current = ((e.target as Element).closest?.('[data-i]') as HTMLElement | null)?.dataset.id;
  };
  const onListFocus = (e: FocusEvent) => {
    if (pinnedRef.current) return;
    const row = e.target as HTMLElement;
    if (row.dataset?.i !== undefined && row.matches(':focus-visible')) scheduleCard(row, CARD_DELAY);
  };

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
            placeholder="Search: method, path or app"
            value={typed}
            onInput={(e) => onType((e.target as HTMLInputElement).value)}
            aria-label="Search operations"
            data-testid="search"
          />
          {!typed && <kbd class="rab-n-search-kbd" aria-hidden="true">/</kbd>}
        </div>
        <div class="rab-n-status">
          <span class="rab-n-status-text" data-testid="status">
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
            ) : searching || p.supportedOnly ? (
              <>{hits.length.toLocaleString()} of {total.toLocaleString()} operations</>
            ) : (
              <>{total.toLocaleString()} operations in {s.modules.length} modules</>
            )}
          </span>
          {!searching && s && lines.length > 0 && (
            <button
              class="rab-n-mini"
              onClick={toggleAll}
              title={allCollapsed ? 'Expand all modules' : 'Collapse all modules'}
              aria-label={allCollapsed ? 'Expand all modules' : 'Collapse all modules'}
              data-testid="toggle-modules"
              data-state={allCollapsed ? 'collapsed' : 'expanded'}
            >
              <svg class="rab-n-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
                <path d={allCollapsed ? 'M5.5 8h5M8 5.5v5' : 'M5.5 8h5'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          )}
          <button
            class={'rab-n-pill' + (p.supportedOnly ? ' on' : '')}
            aria-pressed={p.supportedOnly}
            onClick={() => p.onSupportedOnly(!p.supportedOnly)}
            title="Only the product's supported public APIs"
            data-testid="supported-only"
          >
            Supported only
          </button>
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
        <div class="rab-n-list" onMouseOver={onListOver} onMouseLeave={hideCard} onMouseDown={onListDown}
             onScrollCapture={hideCard} onFocusIn={onListFocus} onFocusOut={hideCard}>
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
                  index={i}
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
            const full = (m ? m.path + '/' : '') + l.op.path;
            return (
              <button
                class={'rab-n-op' + (l.op.key === p.selectedKey ? ' selected' : '') + (i === active ? ' active' : '') + (searching ? '' : ' indented')}
                onClick={() => {
                  setActive(i);
                  p.onSelect(l.op);
                }}
                data-testid="op"
                data-method={l.op.method}
                data-path={full}
                data-i={i}
                data-id={l.op.key}
              >
                <MethodBadge method={l.op.method} />
                <span class="rab-n-op-path">
                  {searching ? <PathText path={full} prefix={m?.path.length} words={words} /> : <PathText path={'/' + l.op.path} />}
                </span>
                <Ticks facts={rowTicks(l.op, m, searching)} />
              </button>
            );
          }}
        />
        </div>
      )}
      {card && <RowCard target={card.target} baseUrl={s?.baseUrl ?? ''} left={card.left} top={card.top} rowHeight={ROW}
                        pinned={pinned} boxRef={cardBox} />}
    </div>
  );
}

function ModuleRow({ index, module, count, collapsed, active, onClick }: {
  index: number; module: Module; count: number; collapsed: boolean; active: boolean; onClick: () => void;
}) {
  const kind = moduleFact(module);
  return (
    <button
      class={
        'rab-n-module' +
        (module.stability === 'supported' ? ' supported' : '') +
        (active ? ' active' : '') +
        (module.state !== 'ok' ? ' ' + module.state : '')
      }
      onClick={onClick}
      aria-expanded={!collapsed}
      data-testid="module"
      data-i={index}
      data-id={'module:' + module.id}
    >
      <span class="rab-n-chevron">{collapsed ? '▸' : '▾'}</span>
      <span class="rab-n-module-path"><PathText path={module.path} rank={false} /></span>
      <Ticks facts={kind ? [kind] : []} />
      <span class="rab-n-count">
        {module.state === 'ok' ? count : module.state === 'pending' ? '…' : 'failed: ' + (module.reason ?? 'error')}
      </span>
    </button>
  );
}

/** Small color ticks for what the row is (supported, app, deprecated, access); the hover card spells them out. */
function Ticks({ facts }: { facts: Fact[] }) {
  if (!facts.length) return null;
  return (
    <span class="rab-n-ticks">
      {facts.map((f) => <span key={f.tone} class={'rab-n-tick rab-n-tone-' + f.tone} />)}
      <span class="rab-n-sr">{facts.map((f) => f.label).join(', ')}</span>
    </span>
  );
}
