import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import type { Module, Operation, Summary } from '../core/types';
import type { Matcher, RouteMatch } from '../core/routes';
import { groupRows, matchUrlQuery, search, type GroupRow, type SearchRow } from '../core/search';
import { VirtualList } from './VirtualList';
import { MethodBadge, PathText, plural, usePin } from './bits';
import { searchWords } from '../lib/jaxrs-router';
import { moduleFact, rowTicks, type Fact } from '../core/facts';
import { isWaiting, moduleReason, rowLabel } from '../core/explain';
import type { StartFailure } from '../core/catalog';
import { RowCard, type CardTarget } from './RowCard';
import { tipProps } from '../core/uitips';
import { ESCAPE_PRIORITY, isInsideInert, onInertChange, useEscape } from '../lib/overlay';

const ROW = 24;
const CARD_ID = 'rab-n-row-card';
const CARD_DELAY = 450;

export interface SidebarProps {
  summary: Summary | null;
  rows: SearchRow[];
  matcher?: Matcher;
  selectedKey?: string;
  onSelect: (op: Operation, urlMatch?: RouteMatch) => void;
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
  const [typed, setTyped] = useState(p.query);
  const typing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(typing.current), []);

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
  const onSearchKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !typed) return;
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(typing.current);
    typing.current = undefined;
    setTyped('');
    query('');
  };
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
  const urlMatches = useMemo(
    () => (searching ? matchUrlQuery(p.rows, p.query, p.matcher, { supportedOnly: p.supportedOnly }) : new Map<string, RouteMatch>()),
    [p.rows, p.query, p.matcher, p.supportedOnly, searching],
  );
  const hits = useMemo(
    () => search(p.rows, p.query, { supportedOnly: p.supportedOnly }, p.matcher, urlMatches),
    [p.rows, p.query, p.supportedOnly, p.matcher, urlMatches],
  );
  const lines: Line[] = useMemo(() => {
    if (searching) return hits.map((h) => ({ kind: 'op', op: h.op, module: h.module }) as Line);
    if (!p.summary) return [];
    return groupRows(p.summary, hits, p.collapsed, { supportedOnly: p.supportedOnly }).map((g: GroupRow) =>
      g.kind === 'module' ? g : ({ kind: 'op', op: g.op } as Line),
    );
  }, [hits, searching, p.summary, p.collapsed, p.supportedOnly]);

  const foldable = (m: Module) => m.state === 'ok';
  const allCollapsed = useMemo(
    () => !searching && lines.some((l) => l.kind === 'module' && foldable(l.module))
      && lines.every((l) => l.kind !== 'module' || !foldable(l.module) || p.collapsed.has(l.module.id)),
    [lines, searching, p.collapsed],
  );
  const toggleAll = () => p.onCollapsed(allCollapsed ? new Set() : new Set((p.summary?.modules ?? []).filter(foldable).map((m) => m.id)));
  const hiddenBySupported = useMemo(
    () => (p.supportedOnly && hits.length === 0 ? search(p.rows, p.query, {}, p.matcher).length : 0),
    [hits, p.rows, p.query, p.supportedOnly, p.matcher],
  );

  const [activeId, setActiveId] = useState<string | undefined>(p.selectedKey);
  useEffect(() => setActiveId(p.selectedKey), [p.selectedKey]);
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
  const tabStop = active >= 0 ? active : lines.length ? 0 : -1;
  const focusFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(focusFrame.current), []);
  const setActive = (i: number) => {
    const l = lines[i];
    if (l) setActiveId(idOf(l));
  };

  const input = useRef<HTMLInputElement>(null);
  const covered = () => isInsideInert(input.current);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typingInField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (e.key === '/' && !typingInField && !e.ctrlKey && !e.metaKey && !e.altKey && !covered()) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const [card, setCard] = useState<{ id: string; target: CardTarget; left: number; top: number } | null>(null);
  const cardTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cardFor = useRef<string | undefined>(undefined);
  const suppressed = useRef<string | undefined>(undefined);
  const cardBox = useRef<HTMLDivElement | null>(null);
  const listBox = useRef<HTMLDivElement>(null);
  const forceHide = () => {
    clearTimeout(cardTimer.current);
    cardFor.current = undefined;
    setCard(null);
  };
  const [pinned] = usePin(() => !!card, cardBox, forceHide);
  const pinnedRef = useRef(false);
  pinnedRef.current = pinned;
  const hideCard = () => {
    if (!pinnedRef.current) forceHide();
  };
  useEffect(() => () => clearTimeout(cardTimer.current), []);

  useEscape(!!card && !pinned, () => {
    if (covered()) return false;
    forceHide();
    return true;
  }, ESCAPE_PRIORITY.TOOLTIP);

  useEffect(() => {
    if (!card) return;
    const dismissIfInert = () => {
      if (covered()) forceHide();
    };
    dismissIfInert();
    return onInertChange(dismissIfInert);
  }, [!!card]);

  // Refresh a pinned card when catalog updates (e.g. a waiting module finishes starting), or re-schedule unpinned hover.
  useEffect(() => {
    if (pinnedRef.current) {
      setCard((prev) => {
        if (!prev) return prev;
        const fresh = lines.find((l) => idOf(l) === prev.id);
        if (!fresh) return prev;
        const target: CardTarget = fresh.kind === 'op'
          ? { kind: 'op', op: fresh.op, module: fresh.module ?? modulesById.get(fresh.op.module) }
          : { kind: 'module', module: fresh.module, count: fresh.count };
        return { ...prev, target };
      });
      return;
    }
    forceHide();
    const row = listBox.current?.querySelector('[data-i]:hover, [data-i]:focus-visible') as HTMLElement | null;
    if (row) scheduleCard(row, CARD_DELAY);
  }, [lines, modulesById]);

  const scheduleCard = (row: HTMLElement, delay: number) => {
    const id = row.dataset.id;
    if (!id || cardFor.current === id || suppressed.current === id || covered()) return;
    suppressed.current = undefined;
    cardFor.current = id;
    clearTimeout(cardTimer.current);
    cardTimer.current = setTimeout(() => {
      if (covered()) {
        if (cardFor.current === id) cardFor.current = undefined;
        return;
      }
      const l = lines[Number(row.dataset.i)];
      const root = row.closest('.rab-n') as HTMLElement | null;
      const side = row.closest('.rab-n-sidebar') as HTMLElement | null;
      if (!l || !root || !side || !row.isConnected || idOf(l) !== id) {
        if (cardFor.current === id) cardFor.current = undefined;
        return;
      }
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
    else hideCard();
  };
  const onListDown = (e: MouseEvent) => {
    hideCard();
    suppressed.current = ((e.target as Element).closest?.('[data-i]') as HTMLElement | null)?.dataset.id;
  };
  const onListLeave = () => {
    suppressed.current = undefined;
    hideCard();
  };
  const onListFocus = (e: FocusEvent) => {
    const row = e.target as HTMLElement;
    if (row.dataset?.i === undefined) return;
    const i = Number(row.dataset.i);
    if (i !== active) setActive(i);
    if (!pinnedRef.current && row.matches(':focus-visible')) {
      suppressed.current = undefined;
      scheduleCard(row, CARD_DELAY);
    }
  };

  const toggle = (id: string) => {
    const next = new Set(p.collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    p.onCollapsed(next);
  };
  const activate = (l: Line) => {
    if (l.kind === 'op') p.onSelect(l.op, urlMatches.get(l.op.key));
    else if (foldable(l.module)) toggle(l.module.id);
    else if (isWaiting(l.module) && !p.starting?.has(l.module.id)) p.onStart?.(l.module);
  };

  const latestRef = useRef({ lines, activate, setActive });
  latestRef.current = { lines, activate, setActive };
  const handleRowActivate = useCallback((index: number) => {
    latestRef.current.setActive(index);
    const line = latestRef.current.lines[index];
    if (line) latestRef.current.activate(line);
  }, []);

  const onListKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const inSearch = target === input.current;
    const inList = !!target.closest?.('.rab-n-vlist');
    if (!inSearch && !inList) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (inSearch && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') && flushQuery()) {
      e.preventDefault();
      return;
    }
    if (!lines.length) return;
    const page = Math.max(1, Math.floor((target.closest('.rab-n-vlist')?.clientHeight ?? 0) / ROW) - 1);
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, ...(inList ? { PageDown: page, PageUp: -page, Home: -lines.length, End: lines.length } : {}) };
    if (e.key in moves) {
      e.preventDefault();
      const step = moves[e.key];
      const from = active < 0 ? (step > 0 ? -1 : lines.length) : active;
      setActive(Math.min(lines.length - 1, Math.max(0, from + step)));
      if (inList) {
        const list = target.closest('.rab-n-vlist');
        cancelAnimationFrame(focusFrame.current);
        const focus = (tries: number) => {
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
              aria-label={allCollapsed ? 'Expand all modules' : 'Collapse all modules'}
              data-testid="toggle-modules"
              data-state={allCollapsed ? 'collapsed' : 'expanded'}
              {...tipProps({
                title: allCollapsed ? 'Expand all modules' : 'Collapse all modules',
                body: allCollapsed
                  ? 'Open every loaded REST module group to list all operations.'
                  : 'Fold every loaded REST module group to see a compact module overview.',
              })}
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
            data-testid="supported-only"
            {...tipProps({
              title: 'Supported APIs only',
              body: p.supportedOnly
                ? 'Showing only officially supported public REST APIs. Click to include internal and third-party app endpoints.'
                : 'Filter the list to officially supported public REST APIs, hiding internal and app endpoints.',
            })}
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
            <button
              class="rab-n-link"
              onClick={() => p.onSupportedOnly(false)}
              {...tipProps({
                title: 'Show all endpoints',
                body: 'Turn off the "Supported only" filter to include internal product and installed app endpoints.',
              })}
            >
              Include internal and app endpoints ({hiddenBySupported})
            </button>
          )}
        </div>
      ) : (
        <div class="rab-n-list" ref={listBox} onMouseOver={onListOver} onMouseLeave={onListLeave} onMouseDown={onListDown}
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
                  onActivate={handleRowActivate}
                />
              );
            }
            const m = l.module ?? modulesById.get(l.op.module);
            return (
              <OpRow
                index={i}
                op={l.op}
                module={m}
                searching={searching}
                words={words}
                selected={l.op.key === p.selectedKey}
                active={i === active}
                tabStop={i === tabStop}
                described={card?.id === l.op.key}
                onActivate={handleRowActivate}
              />
            );
          }}
        />
        </div>
      )}
      {card && <RowCard id={CARD_ID} target={card.target} left={card.left} top={card.top} rowHeight={ROW}
                        baseUrl={p.summary?.baseUrl}
                        startFailure={card.target.kind === 'module' ? p.startFailures?.get(card.target.module.id)?.message : undefined}
                        pinned={pinned} boxRef={cardBox} />}
    </div>
  );
}

const OpRow = memo(function OpRow({
  index, op, module, searching, words, selected, active, tabStop, described, onActivate,
}: {
  index: number; op: Operation; module?: Module; searching: boolean; words: string[];
  selected: boolean; active: boolean; tabStop: boolean; described: boolean; onActivate: (index: number) => void;
}) {
  const full = (module ? module.path + '/' : '') + op.path;
  const facts = useMemo(() => rowTicks(op, module, searching), [op, module, searching]);
  return (
    <button
      class={'rab-n-op' + (selected ? ' selected' : '') + (active ? ' active' : '') + (searching ? '' : ' indented')}
      tabIndex={tabStop ? 0 : -1}
      aria-current={selected ? 'true' : undefined}
      aria-describedby={described ? CARD_ID : undefined}
      onClick={() => onActivate(index)}
      data-testid="op"
      data-method={op.method}
      data-path={full}
      data-i={index}
      data-id={op.key}
    >
      <MethodBadge method={op.method} />
      <span class="rab-n-op-path">
        {searching ? <PathText path={full} prefix={module?.path.length} words={words} /> : <PathText path={'/' + op.path} />}
      </span>
      <Ticks facts={facts} />
    </button>
  );
});

const ModuleRow = memo(function ModuleRow({
  index, module, count, collapsed, active, tabStop, described, starting, failure, onActivate,
}: {
  index: number; module: Module; count: number; collapsed: boolean; active: boolean; tabStop: boolean; described: boolean;
  starting: boolean; failure?: StartFailure; onActivate: (index: number) => void;
}) {
  const kind = moduleFact(module);
  const foldable = module.state === 'ok';
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
      onClick={() => onActivate(index)}
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
});

function Ticks({ facts }: { facts: Fact[] }) {
  if (!facts.length) return null;
  return (
    <span class="rab-n-ticks">
      {facts.map((f) => <span key={f.tone} class={'rab-n-tick rab-n-tone-' + f.tone} />)}
      <span class="rab-n-sr">{facts.map((f) => f.label).join(', ')}</span>
    </span>
  );
}
