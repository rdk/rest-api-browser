import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import type { Index, Operation, Summary } from '../core/types';
import { CatalogStore } from '../core/catalog';
import { buildRows } from '../core/search';
import { formatState, parseState, type RouteState } from '../core/router';
import { findTemplates } from '../core/template';
import { RequestRunner } from './runner';
import { UserStore, isCredentialHeader } from './userstore';
import { Sidebar } from './Sidebar';
import { OperationView, emptyDraft, type Draft } from './Operation';
import { Menu, type MenuItem } from './Menu';

interface Props {
  baseUrl: string;
  classicUrl: string;
  product: string;
}

const MemoSidebar = memo(Sidebar);
const MemoOperation = memo(OperationView);
const NONE = new Set<string>();
const KEEP_RESPONSES = 5;
const SIDEBAR_WIDTH = 430;
const SPLIT = 0.45;
/** The list may take up to this share of the width. */
const MAX_SIDEBAR = 0.75;

export function App({ baseUrl, classicUrl, product }: Props) {
  const store = useMemo(() => new CatalogStore(baseUrl), [baseUrl]);
  const runner = useMemo(() => new RequestRunner(), []);
  const userStore = useMemo(() => new UserStore(baseUrl || location.host), [baseUrl]);

  const [summary, setSummary] = useState<Summary | null>(null);
  const [index, setIndex] = useState<Index | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>();
  useEffect(() => {
    const sync = () => {
      setSummary(store.summary);
      setIndex(store.index);
      setLoadError(store.error ? describeError(store.error) : undefined);
    };
    const off = store.onChange(sync);
    store.load().then(sync, (e) => setLoadError(describeError(e)));
    return () => {
      off();
      store.stop();
    };
  }, [store]);

  const rows = useMemo(() => (summary && index ? buildRows(summary, index) : []), [summary, index]);
  const opsByKey = useMemo(() => new Map((index?.operations ?? []).map((o) => [o.key, o])), [index]);
  const modulesById = useMemo(() => new Map((summary?.modules ?? []).map((m) => [m.id, m])), [summary]);

  // ---- preferences
  const [query, setQuery] = useState('');
  const [supportedOnly, setSupportedOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_WIDTH);
  const [split, setSplit] = useState(SPLIT);
  useEffect(() => {
    userStore.prefs().then((p) => {
      if (p.supportedOnly !== undefined) setSupportedOnly(p.supportedOnly);
      if (p.collapsed) setCollapsed(new Set(p.collapsed));
      if (p.sidebarWidth) setSidebarWidth(p.sidebarWidth);
      if (p.split) setSplit(p.split);
      setPrefsLoaded(true);
    });
  }, [userStore]);
  // first visit: only the product's supported modules start expanded, decided as soon as the modules are known
  useEffect(() => {
    if (prefsLoaded && collapsed === null && summary) {
      setCollapsed(new Set(summary.modules.filter((m) => m.stability !== 'supported').map((m) => m.id)));
    }
  }, [prefsLoaded, summary, collapsed]);
  const save = useCallback((patch: Parameters<UserStore['setPrefs']>[0]) => void userStore.setPrefs(patch), [userStore]);
  const onSupportedOnly = useCallback((v: boolean) => {
    setSupportedOnly(v);
    save({ supportedOnly: v });
  }, [save]);
  const onCollapsed = useCallback((c: Set<string>) => {
    setCollapsed(c);
    save({ collapsed: [...c] });
  }, [save]);
  const onSplit = useCallback((r: number) => {
    setSplit(r);
    save({ split: r });
  }, [save]);

  // ---- selection, kept in the URL (?op=...)
  const routeState = useRef<RouteState>(parseState(location.search));
  const [selectedKey, setSelectedKey] = useState<string | undefined>(routeState.current.op);
  const drafts = useRef(new Map<string, Draft>());
  useEffect(() => {
    const onPop = () => {
      routeState.current = parseState(location.search);
      if (routeState.current.op !== selectedRef.current) runner.abort();
      setSelectedKey(routeState.current.op);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [runner]);
  const selectedRef = useRef(selectedKey);
  selectedRef.current = selectedKey;
  const select = useCallback((op: Operation) => {
    // switching to another operation cancels the running request
    if (op.key !== selectedRef.current) runner.abort();
    setSelectedKey(op.key);
    routeState.current = { op: op.key, path: {}, q: {}, h: {} };
    const url = location.pathname + formatState(routeState.current);
    if (location.pathname + location.search !== url) history.pushState(null, '', url);
  }, [runner]);
  // drafts are kept for every operation opened, responses (up to 20 MB each) only for the last few
  const withResult = useRef<string[]>([]);
  const onDraft = useCallback((key: string, d: Draft) => {
    drafts.current.set(key, d);
    if (d.result) {
      withResult.current = [key, ...withResult.current.filter((k) => k !== key)];
      for (const old of withResult.current.splice(KEEP_RESPONSES)) {
        const draft = drafts.current.get(old);
        if (draft) drafts.current.set(old, { ...draft, result: null });
      }
    }
  }, []);

  // while the catalog is being (re)built, an open operation stays open even if its module is briefly missing
  const lastOp = useRef<Operation | undefined>(undefined);
  let op = selectedKey ? opsByKey.get(selectedKey) : undefined;
  if (!op && selectedKey && lastOp.current?.key === selectedKey && summary && !summary.complete) op = lastOp.current;
  lastOp.current = op;
  let draft: Draft | undefined;
  if (op) {
    draft = drafts.current.get(op.key);
    if (!draft) {
      draft = prefill(op, emptyDraft(op), routeState.current);
      drafts.current.set(op.key, draft);
    }
  }

  // ---- layout: fill the viewport below the product's header
  const root = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(600);
  useLayoutEffect(() => {
    const measure = () => {
      const top = root.current ? root.current.getBoundingClientRect().top + window.scrollY : 0;
      setHeight(Math.max(420, window.innerHeight - top - 1));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const [refreshError, setRefreshError] = useState<string | undefined>();
  const refresh = useCallback(async () => {
    setRefreshError(undefined);
    try {
      const res = await fetch(baseUrl + '/rest/restbrowser/1/catalog/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Atlassian-Token': 'no-check' },
      });
      if (!res.ok) {
        setRefreshError(res.status === 403 ? 'Only system administrators can rebuild the catalog.' : `The rebuild failed (${res.status}).`);
        return;
      }
      await store.refreshSoon();
    } catch (e) {
      setRefreshError('The rebuild failed: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, [baseUrl, store]);

  const menu: MenuItem[] = [
    {
      id: 'layout',
      label: 'Reset the layout',
      hint: 'The width of the list and the request/response split',
      onSelect: () => {
        setSidebarWidth(SIDEBAR_WIDTH);
        setSplit(SPLIT);
        save({ sidebarWidth: SIDEBAR_WIDTH, split: SPLIT });
      },
    },
    ...(summary?.sysadmin
      ? [{
          id: 'rebuild',
          label: 'Rebuild the catalog',
          hint: summary.complete ? 'Reads every REST module again (system administrators)' : 'The catalog is being built…',
          disabled: !summary.complete,
          onSelect: refresh,
          testId: 'refresh',
          group: true,
        }]
      : []),
    { id: 'classic', label: 'Classic UI', hint: 'The original REST API Browser', href: classicUrl, testId: 'classic-link', group: true },
  ];

  return (
    <div class="rab-n" ref={root} style={{ height: height + 'px' }}>
      <div class="rab-n-topbar">
        <span class="rab-n-brand-mark" aria-hidden="true">
          <svg class="rab-n-svg" width="15" height="15" viewBox="0 0 16 16" fill="none">
            <path d="M5.5 3.5L2.5 8l3 4.5M10.5 3.5L13.5 8l-3 4.5M9 2.5L7 13.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <strong class="rab-n-topbar-title">REST API Browser</strong>
        <span class="rab-n-product-badge">{summary ? `${summary.product.name} ${summary.product.version}` : product}</span>
        <span class="rab-n-spacer" />
        <Menu label="More actions" items={menu} />
      </div>
      <div class="rab-n-body-row">
        <div class="rab-n-side" style={{ width: sidebarWidth + 'px' }}>
          <MemoSidebar
            summary={summary}
            rows={rows}
            selectedKey={selectedKey}
            onSelect={select}
            query={query}
            onQuery={setQuery}
            supportedOnly={supportedOnly}
            onSupportedOnly={onSupportedOnly}
            collapsed={collapsed ?? NONE}
            onCollapsed={onCollapsed}
            loadError={loadError ?? refreshError}
          />
        </div>
        <SideHandle width={sidebarWidth} onWidth={setSidebarWidth} onDone={(w) => save({ sidebarWidth: w })} />
        <div class="rab-n-main">
          {op && draft && summary ? (
            <MemoOperation
              key={op.key}
              summary={summary}
              op={op}
              module={modulesById.get(op.module)}
              initialDraft={draft}
              onDraft={onDraft}
              runner={runner}
              userStore={userStore}
              split={split}
              onSplit={onSplit}
            />
          ) : (
            <Welcome
              summary={summary}
              missing={!!selectedKey && !!index && !op && !!summary?.complete}
              indexing={!!selectedKey && !op && !summary?.complete}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function describeError(e: unknown): string {
  if (e instanceof Error && e.name === 'SessionExpired') return 'Your session has expired: reload the page to log in again.';
  return 'Could not load the catalog: ' + (e instanceof Error ? e.message : String(e));
}

/**
 * Values from a deep link fill the form; they are never sent by themselves. Only parameters the operation declares
 * are taken, so a link cannot add anything the form does not show; other headers go to the visible custom headers,
 * and credential headers are dropped.
 */
function prefill(op: Operation, draft: Draft, state: RouteState): Draft {
  if (state.op !== op.key) return draft;
  const declared = (where: string) => new Set(op.params.filter((p) => p.in === where).map((p) => p.name));
  const pathNames = new Set([...declared('path'), ...findTemplates(op.path).map((t) => t.name)]);
  const queryNames = declared('query');
  // header names compare case-insensitively; a declared header keeps the operation's spelling
  const headerNames = new Map(op.params.filter((p) => p.in === 'header').map((p) => [p.name.toLowerCase(), p.name]));
  const path = Object.fromEntries(Object.entries(state.path).filter(([k]) => pathNames.has(k)));
  const query = Object.fromEntries(Object.entries(state.q).filter(([k]) => queryNames.has(k)));
  const header: Record<string, string> = {};
  const custom: { name: string; value: string }[] = [];
  for (const [raw, value] of Object.entries(state.h)) {
    const name = raw.trim();
    if (!name || isCredentialHeader(name)) continue; // never from a link, declared or not
    const declaredName = headerNames.get(name.toLowerCase());
    if (declaredName) header[declaredName] = value;
    else custom.push({ name, value });
  }
  return {
    ...draft,
    values: { ...draft.values, path, query: { ...draft.values.query, ...query }, header },
    custom,
  };
}

function Welcome({ summary, missing, indexing }: { summary: Summary | null; missing: boolean; indexing: boolean }) {
  const ops = summary ? summary.modules.reduce((n, m) => n + m.opCount, 0) : 0;
  return (
    <div class="rab-n-welcome" data-testid="welcome">
      <div class="rab-n-welcome-inner">
        {missing && <div class="rab-n-banner">The operation in the link no longer exists on this instance.</div>}
        {indexing && <div class="rab-n-banner">The catalog is still being built; the operation in the link opens when its module is ready.</div>}
        <div class="rab-n-welcome-hero">
          <span class="rab-n-welcome-icon" aria-hidden="true">
            <svg class="rab-n-svg" width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <div>
            <h2>Find an operation</h2>
            <p class="rab-n-welcome-lead">
              Type in the search box (<kbd>/</kbd>) to search all {ops ? ops.toLocaleString() + ' ' : ''}operations by method,
              path and app, or browse them by module.
            </p>
          </div>
        </div>
        <ul class="rab-n-welcome-grid">
          <li class="rab-n-welcome-card">
            <div class="rab-n-welcome-card-title">
              <span class="rab-n-welcome-card-dot nav" aria-hidden="true" />
              Navigate
            </div>
            <kbd>↑</kbd> <kbd>↓</kbd> move in the list, <kbd>Enter</kbd> opens
          </li>
          <li class="rab-n-welcome-card">
            <div class="rab-n-welcome-card-title">
              <span class="rab-n-welcome-card-dot run" aria-hidden="true" />
              Execute
            </div>
            <kbd>Ctrl</kbd>+<kbd>Enter</kbd> sends the request, <kbd>Esc</kbd> cancels it
          </li>
          <li class="rab-n-welcome-card">
            <div class="rab-n-welcome-card-title">
              <span class="rab-n-welcome-card-dot hist" aria-hidden="true" />
              Session &amp; History
            </div>
            Requests run as you, in your browser. The History tab keeps the ones you sent.
          </li>
        </ul>
        {summary && summary.modules.some((m) => m.state === 'failed') && (
          <p class="rab-n-subtle rab-n-welcome-note">
            {summary.modules.filter((m) => m.state === 'failed').length} modules could not be described; they are listed
            with the reason.
          </p>
        )}
      </div>
    </div>
  );
}

function SideHandle({ width, onWidth, onDone }: { width: number; onWidth: (w: number) => void; onDone: (w: number) => void }) {
  // the keyboard resizes too: Tab to the divider, then the arrow keys
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const row = ref.current?.parentElement;
    const max = row ? row.clientWidth * MAX_SIDEBAR : Infinity;
    const next = Math.round(Math.min(max, Math.max(240, width + (e.key === 'ArrowRight' ? 20 : -20))));
    onWidth(next);
    onDone(next);
  };
  const ref = useRef<HTMLDivElement>(null);
  const onDown = (e: PointerEvent) => {
    const row = ref.current?.parentElement;
    const side = row?.firstElementChild as HTMLElement | null;
    if (!row || !side) return;
    e.preventDefault();
    const left = row.getBoundingClientRect().left;
    let last = 0;
    // resize the element directly while dragging; the state (and a re-render) follows once, on release
    const move = (ev: PointerEvent) => {
      last = Math.round(Math.min(row.clientWidth * MAX_SIDEBAR, Math.max(240, ev.clientX - left)));
      side.style.width = last + 'px';
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      if (last) {
        onWidth(last);
        onDone(last);
      }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  };
  return (
    <div ref={ref} class="rab-n-vsplit" onPointerDown={onDown} onKeyDown={onKeyDown} tabIndex={0}
         role="separator" aria-orientation="vertical" aria-label="Resize the list" aria-valuenow={width} />
  );
}
