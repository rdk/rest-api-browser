import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Module, Operation, Summary } from '../core/types';
import { groupRows, search, type GroupRow, type SearchRow } from '../core/search';
import { VirtualList } from './VirtualList';
import { MethodBadge, PathText, plural, usePin } from './bits';
import { searchWords } from '../core/pathparts';
import { moduleFact, rowTicks, type Fact } from './facts';
import { isWaiting, moduleReason, rowLabel } from '../core/explain';
import type { StartFailure } from '../core/catalog';
import { RowCard, type CardTarget } from './RowCard';

const ROW = 24;
/** The hover card's id: the row it describes points to it (aria-describedby). */
const CARD_ID = 'rab-n-row-card';
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
  /** Starts a module that has not started yet (Enter or a click on it); see CatalogStore.startModule. */
  onStart?: (m: Module) => void;
  /** The modules being started, and why the last start of a module failed. */
  starting?: ReadonlySet<string>;
  startFailures?: ReadonlyMap<string, StartFailure>;
}

type Line = { kind: 'module'; module: Module; count: number } | { kind: 'op'; op: Operation; module?: Module };

export function Sidebar(p: SidebarProps) {
  // the input shows every key at once; the search runs 120 ms after the last one
  const [typed, setTyped] = useState(p.query);
  const typing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(typing.current), []);
  // a query set from outside (not typed here) shows in the box too
  const sent = useRef(p.query);
  useEffect(() => {
    if (p.query === sent.current) return;
    sent.current = p.query;
    clearTimeout(typing.current);
    typing.current = undefined;
    setTyped(p.query);
  }, [p.query]);
  const query = (v: string) => {
    sent.current = v;
    p.onQuery(v);
  };
  const onType = (v: string) => {
    setTyped(v);
    clearTimeout(typing.current);
    typing.current = setTimeout(() => {
      typing.current = undefined;
      query(v);
    }, 120);
  };
  // Escape in the box clears it (whatever the browser does on its own), and does nothing else
  const onSearchKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !typed) return;
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(typing.current);
    typing.current = undefined;
    setTyped('');
    query('');
  };
  // a key that acts on the list must not act on the results of the previous query: search now, act on the next key
  const flushQuery = () => {
    if (typing.current === undefined) return false;
    clearTimeout(typing.current);
    typing.current = undefined;
    query(typed);
    return true;
  };
  const searching = p.query.trim().length > 0;
  const words = useMemo(() => searchWords(p.query), [p.query]);
  const modulesById = useMemo(() => new Map((p.summary?.modules ?? []).map((m) => [m.id, m])), [p.summary]);
  const hits = useMemo(() => search(p.rows, p.query, { supportedOnly: p.supportedOnly }), [p.rows, p.query, p.supportedOnly]);
  const lines: Line[] = useMemo(() => {
    if (searching) return hits.map((h) => ({ kind: 'op', op: h.op, module: h.module }) as Line);
    if (!p.summary) return [];
    return groupRows(p.summary, hits, p.collapsed, { supportedOnly: p.supportedOnly }).map((g: GroupRow) =>
      g.kind === 'module' ? g : ({ kind: 'op', op: g.op } as Line),
    );
  }, [hits, searching, p.summary, p.collapsed, p.supportedOnly]);
  // one small button folds or unfolds every module: unfold when all the listed ones are folded, else fold them all;
  // pending and failed modules have nothing to fold
  const foldable = (m: Module) => m.state === 'ok';
  const allCollapsed = useMemo(
    () => !searching && lines.some((l) => l.kind === 'module' && foldable(l.module))
      && lines.every((l) => l.kind !== 'module' || !foldable(l.module) || p.collapsed.has(l.module.id)),
    [lines, searching, p.collapsed],
  );
  const toggleAll = () => p.onCollapsed(allCollapsed ? new Set() : new Set((p.summary?.modules ?? []).filter(foldable).map((m) => m.id)));
  const hiddenBySupported = useMemo(
    () => (p.supportedOnly && hits.length === 0 ? search(p.rows, p.query).length : 0),
    [hits, p.rows, p.query, p.supportedOnly],
  );

  // the keyboard's position in the list, by row identity, so a list that changes (a module expanded, a new search)
  // does not move it; it follows the selection only when the selection changes
  const [activeId, setActiveId] = useState<string | undefined>(p.selectedKey);
  useEffect(() => setActiveId(p.selectedKey), [p.selectedKey]);
  // a new search or filter starts at the top of its results, not where the previous list was scrolled
  const listKey = p.query + '|' + p.supportedOnly;
  const firstKey = useRef(listKey);
  useEffect(() => {
    if (firstKey.current === listKey) return;
    firstKey.current = listKey;
    setActiveId(undefined);
  }, [listKey]);
  const idOf = (l: Line) => (l.kind === 'op' ? l.op.key : 'module:' + l.module.id);
  const active = useMemo(() => (activeId ? lines.findIndex((l) => idOf(l) === activeId) : -1), [lines, activeId]);
  const reveal = useRef({ id: activeId, shown: false, seq: 0 });
  if (reveal.current.id !== activeId || reveal.current.shown !== active >= 0) {
    reveal.current = { id: activeId, shown: active >= 0, seq: reveal.current.seq + 1 };
  }
  // the list's one tab stop: the keyboard's row, else the first (kept rendered while the list scrolls)
  const tabStop = active >= 0 ? active : lines.length ? 0 : -1;
  const focusFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(focusFrame.current), []);
  const setActive = (i: number) => {
    const l = lines[i];
    if (l) setActiveId(idOf(l));
  };

  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      // not with a modifier (Ctrl+/ belongs to the browser), nor into a list hidden behind a box on the whole screen
      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !input.current?.closest('[inert]')) {
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
  // the row clicked last: no card for it until the pointer moves on to another row
  const suppressed = useRef<string | undefined>(undefined);
  const cardBox = useRef<HTMLDivElement | null>(null);
  const listBox = useRef<HTMLDivElement>(null);
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
  useEffect(() => () => clearTimeout(cardTimer.current), []);
  // other rows (a search, a fold, the catalog updated): the card goes, and the row the pointer rests on gets its card
  // again, as a pending one would have (its timer went with the old rows)
  useEffect(() => {
    if (pinnedRef.current) return;
    forceHide();
    const row = listBox.current?.querySelector('[data-i]:hover') as HTMLElement | null;
    if (row) scheduleCard(row, CARD_DELAY);
  }, [lines]);
  // a box on the whole screen covers the list: its card goes too, and stays away
  const covered = () => !!input.current?.closest('[inert]');
  // Escape hides a card that is not pinned (the pinned one has its own Escape), and only that; not a covered one
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && shownRef.current && !pinnedRef.current && !covered()) {
        e.stopPropagation();
        forceHide();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  const scheduleCard = (row: HTMLElement, delay: number) => {
    const id = row.dataset.id;
    if (!id || cardFor.current === id || suppressed.current === id) return;
    suppressed.current = undefined;
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
    else hideCard(); // the empty space below a short list
  };
  // a click closes the card, and it stays closed until the pointer moves on to another row
  const onListDown = (e: MouseEvent) => {
    hideCard();
    suppressed.current = ((e.target as Element).closest?.('[data-i]') as HTMLElement | null)?.dataset.id;
  };
  const onListFocus = (e: FocusEvent) => {
    const row = e.target as HTMLElement;
    if (row.dataset?.i === undefined) return;
    // the keyboard's position follows the focus, so the arrows go on from the row that has it
    const i = Number(row.dataset.i);
    if (i !== active) setActive(i);
    if (!pinnedRef.current && row.matches(':focus-visible')) scheduleCard(row, CARD_DELAY);
  };

  const toggle = (id: string) => {
    const next = new Set(p.collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    p.onCollapsed(next);
  };
  // what Enter or a click does on a row: opens an operation, folds a module, starts one that has not started
  const activate = (l: Line) => {
    if (l.kind === 'op') p.onSelect(l.op);
    else if (foldable(l.module)) toggle(l.module.id);
    else if (isWaiting(l.module) && !p.starting?.has(l.module.id)) p.onStart?.(l.module);
  };

  // keys for the list, from the search box or the list itself; the filter buttons keep their own Enter
  const onListKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const inSearch = target === input.current;
    const inList = !!target.closest?.('.rab-n-vlist');
    if (!inSearch && !inList) return;
    // Ctrl+Enter sends the open request (Operation); the list leaves modified keys alone
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (inSearch && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') && flushQuery()) {
      e.preventDefault();
      return;
    }
    if (!lines.length) return;
    // Home, End, PageUp and PageDown move in the list itself (in the search box they move the caret)
    const page = Math.max(1, Math.floor((target.closest('.rab-n-vlist')?.clientHeight ?? 0) / ROW) - 1);
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, ...(inList ? { PageDown: page, PageUp: -page, Home: -lines.length, End: lines.length } : {}) };
    if (e.key in moves) {
      e.preventDefault();
      const step = moves[e.key];
      const from = active < 0 ? (step > 0 ? -1 : lines.length) : active;
      setActive(Math.min(lines.length - 1, Math.max(0, from + step)));
      if (inList) {
        // keep the keyboard focus on the highlighted row; a row out of the rendered window appears only after the
        // list has scrolled to it, a frame or two later
        const list = target.closest('.rab-n-vlist');
        cancelAnimationFrame(focusFrame.current);
        const focus = (tries: number) => {
          // only while the focus is still in the list: a click or Tab elsewhere in between wins
          if (!list?.contains(document.activeElement)) return;
          const row = list.querySelector('.rab-n-op.active, .rab-n-module.active') as HTMLElement | null;
          if (row) row.focus();
          else if (tries > 0) focusFrame.current = requestAnimationFrame(() => focus(tries - 1));
        };
        focusFrame.current = requestAnimationFrame(() => focus(5));
      }
    } else if (e.key === 'Enter' && inSearch && active >= 0 && active < lines.length) {
      e.preventDefault();
      activate(lines[active]);
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && inList && active >= 0 && active < lines.length) {
      const l = lines[active];
      if (l.kind === 'module' && foldable(l.module) && p.collapsed.has(l.module.id) === (e.key === 'ArrowRight')) toggle(l.module.id);
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
            onKeyDown={onSearchKey}
            aria-label="Search operations"
            data-testid="search"
          />
          {!typed && <kbd class="rab-n-search-kbd" aria-hidden="true">/</kbd>}
        </div>
        <div class="rab-n-status">
          <span class="rab-n-status-text" data-testid="status" role="status">
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
              <>{hits.length.toLocaleString()} of {plural(total, 'operation')}</>
            ) : (
              <>{plural(total, 'operation')} in {plural(s.modules.length, 'module')}</>
            )}
          </span>
          {!searching && s && lines.some((l) => l.kind === 'module' && foldable(l.module)) && (
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
          <span>
            {!s.complete ? 'No operation matches yet; the catalog is still being built.'
              : !searching && !p.supportedOnly && total === 0 ? 'No REST operations were found on this instance.'
              : 'No operation matches.'}
          </span>
          {hiddenBySupported > 0 && (
            <button class="rab-n-link" onClick={() => p.onSupportedOnly(false)}>
              Include internal and app endpoints ({hiddenBySupported})
            </button>
          )}
        </div>
      ) : (
        <div class="rab-n-list" ref={listBox} onMouseOver={onListOver} onMouseLeave={hideCard} onMouseDown={onListDown}
             onScrollCapture={hideCard} onFocusIn={onListFocus} onFocusOut={hideCard}>
        <VirtualList
          count={lines.length}
          rowHeight={ROW}
          activeIndex={active}
          followIndex={false}
          revealKey={reveal.current.seq}
          keepIndex={tabStop}
          keyOf={(i) => idOf(lines[i])}
          resetKey={listKey}
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
                  tabStop={i === tabStop}
                  described={card?.id === idOf(l)}
                  starting={!!p.starting?.has(l.module.id)}
                  failure={p.startFailures?.get(l.module.id)}
                  onClick={() => {
                    setActive(i);
                    activate(l);
                  }}
                />
              );
            }
            const m = l.module ?? modulesById.get(l.op.module);
            const full = (m ? m.path + '/' : '') + l.op.path;
            return (
              <button
                class={'rab-n-op' + (l.op.key === p.selectedKey ? ' selected' : '') + (i === active ? ' active' : '') + (searching ? '' : ' indented')}
                tabIndex={i === tabStop ? 0 : -1}
                aria-current={l.op.key === p.selectedKey ? 'true' : undefined}
                aria-describedby={card?.id === l.op.key ? CARD_ID : undefined}
                onClick={() => {
                  setActive(i);
                  activate(l);
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
      {card && <RowCard id={CARD_ID} target={card.target} left={card.left} top={card.top} rowHeight={ROW}
                        startFailure={card.target.kind === 'module' ? p.startFailures?.get(card.target.module.id)?.message : undefined}
                        pinned={pinned} boxRef={cardBox} />}
    </div>
  );
}

function ModuleRow({ index, module, count, collapsed, active, tabStop, described, starting, failure, onClick }: {
  index: number; module: Module; count: number; collapsed: boolean; active: boolean; tabStop: boolean; described: boolean;
  starting: boolean; failure?: StartFailure; onClick: () => void;
}) {
  const kind = moduleFact(module);
  // a pending or failed module has no operations to fold: no chevron, no expanded state
  const foldable = module.state === 'ok';
  // why a module could not be read, as its class: waiting (Enter or a click starts it), skipped on purpose, failed
  const reason = moduleReason(module);
  return (
    <button
      class={
        'rab-n-module' +
        (module.stability === 'supported' ? ' supported' : '') +
        (active ? ' active' : '') +
        (reason ? ' ' + reason.kind : module.state === 'pending' ? ' pending' : '') +
        (starting ? ' starting' : '')
      }
      onClick={onClick}
      tabIndex={tabStop ? 0 : -1}
      aria-busy={starting || undefined}
      aria-expanded={foldable ? !collapsed : undefined}
      aria-describedby={described ? CARD_ID : undefined}
      data-testid="module"
      data-i={index}
      data-id={'module:' + module.id}
    >
      <span class="rab-n-chevron" aria-hidden="true">
        {foldable && (
          <svg class="rab-n-svg" width="10" height="10" viewBox="0 0 16 16" fill="none">
            <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      {/* the module's kind (supported, app, bundled; none for the product's internal APIs) as the icon's colour */}
      <span class={'rab-n-module-icon' + (kind ? ' rab-n-tone-' + kind.tone : '')} aria-hidden="true">
        <svg class="rab-n-svg" width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M8 2.2l5.8 2.9L8 8 2.2 5.1 8 2.2z" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <path d="M2.2 8.1L8 11l5.8-2.9M2.2 11L8 13.9l5.8-2.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span class="rab-n-module-path"><PathText path={module.path} rank={false} /></span>
      {kind && <span class="rab-n-sr">{kind.label}</span>}
      <span class="rab-n-count">
        {!reason ? (module.state === 'ok' ? count : '…')
          : starting ? <><span class="rab-n-spinner" aria-hidden="true" /> starting…</>
          : reason.kind === 'waiting'
            ? <>
                {!failure ? rowLabel(reason) : failure.notStarted ? 'did not start' : 'start failed'}
                <span class="rab-n-count-sep" aria-hidden="true">·</span><span class="rab-n-sr">, </span>
                <span class="rab-n-count-action">{failure ? 'try again' : 'start'}</span>
              </>
            : rowLabel(reason)}
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
