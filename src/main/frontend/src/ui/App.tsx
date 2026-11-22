import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Index, Operation, Summary } from '../core/types';
import { CatalogStore } from '../core/catalog';
import { buildRows } from '../core/search';
import { formatState, parseState } from '../core/router';
import { RequestRunner } from './runner';
import { UserStore } from './userstore';
import { Sidebar } from './Sidebar';
import { OperationView, emptyDraft, type Draft } from './Operation';

interface Props {
  baseUrl: string;
  classicUrl: string;
  product: string;
}

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
    };
    const off = store.onChange(sync);
    store.load().then(sync, (e) => setLoadError('Could not load the catalog: ' + (e instanceof Error ? e.message : e)));
    return () => {
      off();
      store.stop();
    };
  }, [store]);

  const rows = useMemo(() => (summary && index ? buildRows(summary, index) : []), [summary, index]);
  const opsByKey = useMemo(() => new Map((index?.operations ?? []).map((o) => [o.key, o])), [index]);

  // ---- preferences
  const [query, setQuery] = useState('');
  const [supportedOnly, setSupportedOnly] = useState(false);
  const [methods, setMethods] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(430);
  const [split, setSplit] = useState(0.45);
  useEffect(() => {
    userStore.prefs().then((p) => {
      if (p.supportedOnly !== undefined) setSupportedOnly(p.supportedOnly);
      if (p.methods) setMethods(p.methods);
      if (p.collapsed) setCollapsed(new Set(p.collapsed));
      if (p.sidebarWidth) setSidebarWidth(p.sidebarWidth);
      if (p.split) setSplit(p.split);
    });
  }, [userStore]);
  // first visit: only the product's supported modules start expanded
  useEffect(() => {
    if (collapsed === null && summary?.complete) {
      setCollapsed(new Set(summary.modules.filter((m) => m.stability !== 'supported').map((m) => m.id)));
    }
  }, [summary, collapsed]);
  const save = (patch: Parameters<UserStore['setPrefs']>[0]) => void userStore.setPrefs(patch);

  // ---- selection, kept in the URL (?op=...)
  const initial = useMemo(() => parseState(location.search), []);
  const [selectedKey, setSelectedKey] = useState<string | undefined>(initial.op);
  const drafts = useRef(new Map<string, Draft>());
  const [, rerender] = useState(0);
  useEffect(() => {
    const onPop = () => setSelectedKey(parseState(location.search).op);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const select = useCallback((op: Operation) => {
    setSelectedKey(op.key);
    const url = location.pathname + formatState({ op: op.key, path: {}, q: {}, h: {} });
    if (location.pathname + location.search !== url) history.pushState(null, '', url);
  }, []);

  const op = selectedKey ? opsByKey.get(selectedKey) : undefined;
  let draft: Draft | undefined;
  if (op) {
    draft = drafts.current.get(op.key);
    if (!draft) {
      draft = emptyDraft(op);
      if (initial.op === op.key) {
        // values from a deep link fill the form; they are never sent by themselves
        draft.values = {
          ...draft.values,
          path: { ...initial.path },
          query: { ...draft.values.query, ...initial.q },
          header: { ...initial.h },
        };
      }
      drafts.current.set(op.key, draft);
    }
  }

  // ---- layout: fill the viewport below the product's header, no page scrollbar
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

  const refresh = async () => {
    await fetch(baseUrl + '/rest/restbrowser/1/catalog/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Atlassian-Token': 'no-check' },
    });
    await store.load();
  };

  return (
    <div class="rab-n" ref={root} style={{ height: height + 'px' }}>
      <div class="rab-n-topbar">
        <strong>REST API Browser</strong>
        <span class="rab-n-subtle">{summary ? `${summary.product.name} ${summary.product.version}` : product}</span>
        <span class="rab-n-spacer" />
        <a class="rab-n-link" href={classicUrl} data-testid="classic-link">Classic UI</a>
      </div>
      <div class="rab-n-body-row">
        <div class="rab-n-side" style={{ width: sidebarWidth + 'px' }}>
          <Sidebar
            summary={summary}
            rows={rows}
            selectedKey={selectedKey}
            onSelect={select}
            query={query}
            onQuery={setQuery}
            supportedOnly={supportedOnly}
            onSupportedOnly={(v) => {
              setSupportedOnly(v);
              save({ supportedOnly: v });
            }}
            methods={methods}
            onMethods={(m) => {
              setMethods(m);
              save({ methods: m });
            }}
            collapsed={collapsed ?? new Set()}
            onCollapsed={(c) => {
              setCollapsed(c);
              save({ collapsed: [...c] });
            }}
            onRefresh={summary?.admin ? refresh : undefined}
            loadError={loadError}
          />
        </div>
        <SideHandle
          onWidth={(w) => setSidebarWidth(w)}
          onDone={(w) => save({ sidebarWidth: w })}
        />
        <div class="rab-n-main">
          {op && draft && summary ? (
            <OperationView
              key={op.key}
              summary={summary}
              op={op}
              module={summary.modules.find((m) => m.id === op.module)}
              draft={draft}
              onDraft={(d) => {
                drafts.current.set(op.key, d);
                rerender((n) => n + 1);
              }}
              runner={runner}
              userStore={userStore}
              split={split}
              onSplit={(r) => {
                setSplit(r);
                save({ split: r });
              }}
            />
          ) : (
            <Welcome summary={summary} missing={!!selectedKey && !!index && !op} />
          )}
        </div>
      </div>
    </div>
  );
}

function Welcome({ summary, missing }: { summary: Summary | null; missing: boolean }) {
  const ops = summary ? summary.modules.reduce((n, m) => n + m.opCount, 0) : 0;
  return (
    <div class="rab-n-welcome" data-testid="welcome">
      {missing && <div class="rab-n-banner">The operation in the link no longer exists on this instance.</div>}
      <h2>Find an operation</h2>
      <p>
        Type in the search box (<kbd>/</kbd>) to search all {ops ? ops.toLocaleString() + ' ' : ''}operations by method,
        path and app, or browse them by module.
      </p>
      <ul>
        <li><kbd>↑</kbd> <kbd>↓</kbd> move in the list, <kbd>Enter</kbd> opens</li>
        <li><kbd>Ctrl</kbd>+<kbd>Enter</kbd> sends the request, <kbd>Esc</kbd> cancels it</li>
        <li>Requests run as you, in your browser. The History tab keeps the ones you sent.</li>
      </ul>
      {summary && summary.modules.some((m) => m.state === 'failed') && (
        <p class="rab-n-subtle">
          {summary.modules.filter((m) => m.state === 'failed').length} modules could not be described; they are listed
          with the reason.
        </p>
      )}
    </div>
  );
}

function SideHandle({ onWidth, onDone }: { onWidth: (w: number) => void; onDone: (w: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onDown = (e: PointerEvent) => {
    const row = ref.current?.parentElement;
    if (!row) return;
    e.preventDefault();
    const left = row.getBoundingClientRect().left;
    let last = 0;
    const move = (ev: PointerEvent) => {
      last = Math.round(Math.min(row.clientWidth * 0.6, Math.max(240, ev.clientX - left)));
      onWidth(last);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      if (last) onDone(last);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };
  return <div ref={ref} class="rab-n-vsplit" onPointerDown={onDown} role="separator" aria-orientation="vertical" />;
}
