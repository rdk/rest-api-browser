import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import { CatalogStore, StartStopped, isSessionExpired } from '../core/catalog';
import { clearDetails, type DecompilerId } from '../core/details';
import { describeCatalogError } from '../core/detailserror';
import { isWaiting } from '../core/explain';
import { emptyDraft, type Draft } from '../core/operationform';
import { prefill } from '../core/prefill';
import { formatState, parseState, type RouteState } from '../core/router';
import { createMatcher, type RouteMatch } from '../core/routes';
import { buildRows } from '../core/search';
import {
  canNavigateSourceBack, canNavigateSourceForward, closeAllSourceTabs, closeSourceTab, EMPTY_SOURCE_TABS,
  minimizeSourceDialog, navigateSourceBack, navigateSourceForward, openSourceTab, recordSourceLocation,
  resolveSourceTab, selectSourceTab, showSourceDialog, undoCloseSourceTabs,
  type OpenTabRequest, type SourceNavEntry, type SourceTabsState,
} from '../core/sourcetabs';
import { applyMode, isMode, skinOf, type Mode } from '../core/theme';
import type { Index, Module, Operation, Summary } from '../core/types';
import { SplitHandle } from '../lib/overlay';
import { ClassHoverCard } from './java/ClassHoverCard';
import type { JavaPage } from './JavaTab';
import { OperationView, type RequestTab } from './Operation';
import { RequestRunner } from './runner';
import { Sidebar } from './Sidebar';
import { SourceDialog } from './source/SourceDialog';
import { TopBar } from './TopBar';
import { UiTipLayer } from './UiTipLayer';
import { UserStore } from './userstore';
import { Welcome } from './Welcome';

interface Props {
  baseUrl: string;
  classicUrl: string;
  product: string;
  /** This app's version, empty when unknown. */
  version: string;
  /** The product's base URL as configured ("https://jira.example.com"), empty when unknown. */
  siteUrl: string;
  /** The user's key, which keeps their request history apart from other users of this browser; empty when anonymous. */
  user?: string;
}

const MemoSidebar = memo(Sidebar);
const MemoOperation = memo(OperationView);
const NONE = new Set<string>();
const KEEP_RESPONSES = 5;
const SIDEBAR_WIDTH = 430;
const MIN_SIDEBAR = 240;
const SPLIT = 0.45;
const OUTLINE_WIDTH = 240;
const MAX_SIDEBAR = 0.75;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function App({ baseUrl, classicUrl, product, version, siteUrl, user }: Props) {
  const store = useMemo(() => new CatalogStore(baseUrl), [baseUrl]);
  const runner = useMemo(() => new RequestRunner(), []);
  const userStore = useMemo(() => new UserStore(baseUrl || location.host, user || undefined), [baseUrl, user]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [summary, setSummary] = useState<Summary | null>(null);
  const [index, setIndex] = useState<Index | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [starting, setStarting] = useState(store.starting);
  const [startFailures, setStartFailures] = useState(store.startFailures);
  const lastHash = useRef<string | undefined>(undefined);
  useEffect(() => {
    const sync = () => {
      const nextHash = store.summary?.hash;
      if (nextHash && lastHash.current && nextHash !== lastHash.current) {
        clearDetails();
      }
      if (nextHash) lastHash.current = nextHash;
      setSummary(store.summary);
      setIndex(store.index);
      setLoadError(store.error ? describeCatalogError(store.error) : undefined);
      setStarting(store.starting);
      setStartFailures(store.startFailures);
    };
    const off = store.onChange(sync);
    let live = true;
    store.load().then(() => live && sync(), (e) => live && setLoadError(describeCatalogError(e)));
    return () => {
      live = false;
      off();
      store.stop();
    };
  }, [store]);

  const rows = useMemo(() => (summary && index ? buildRows(summary, index) : []), [summary, index]);
  const matcher = useMemo(() => (summary && index ? createMatcher(summary, index) : undefined), [summary, index]);
  const opsByKey = useMemo(() => new Map((index?.operations ?? []).map((o) => [o.key, o])), [index]);
  const modulesById = useMemo(() => new Map((summary?.modules ?? []).map((m) => [m.id, m])), [summary]);

  const stored = useMemo(() => userStore.prefsNow(), [userStore]);
  const [query, setQuery] = useState('');
  const [supportedOnly, setSupportedOnly] = useState(!!stored.supportedOnly);
  const [collapsed, setCollapsed] = useState<Set<string> | null>(stored.collapsed ? new Set(stored.collapsed) : null);
  const [sidebarWidth, setSidebarWidth] = useState(stored.sidebarWidth || SIDEBAR_WIDTH);
  const [liveSidebarWidth, setLiveSidebarWidth] = useState<number | null>(null);
  const [split, setSplit] = useState(stored.split || SPLIT);
  const [outlineWidth, setOutlineWidth] = useState(stored.outlineWidth || OUTLINE_WIDTH);
  const [skin, setSkin] = useState(skinOf(stored.skin));
  const [mode, setMode] = useState<Mode | null>(isMode(stored.mode) ? stored.mode : null);
  useLayoutEffect(() => (mode ? applyMode(mode) : undefined), [mode]);

  const defaultCollapsed = useMemo(
    () => (summary ? new Set(summary.modules.filter((m) => m.stability !== 'supported').map((m) => m.id)) : NONE),
    [summary],
  );
  const shownCollapsed = collapsed ?? defaultCollapsed;
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
  const onOutlineWidth = useCallback((w: number) => {
    setOutlineWidth(w);
    save({ outlineWidth: w });
  }, [save]);
  const onModeChange = useCallback((m: Mode) => {
    setMode(m);
    save({ mode: m });
  }, [save]);
  const onSkinChange = useCallback((s: string) => {
    setSkin(s);
    save({ skin: s });
  }, [save]);
  const onResetLayout = useCallback(() => {
    setLiveSidebarWidth(null);
    setSidebarWidth(SIDEBAR_WIDTH);
    setSplit(SPLIT);
    setOutlineWidth(OUTLINE_WIDTH);
    save({ sidebarWidth: SIDEBAR_WIDTH, split: SPLIT, outlineWidth: OUTLINE_WIDTH });
  }, [save]);
  const onCommitSidebarWidth = useCallback((w: number) => {
    setLiveSidebarWidth(null);
    setSidebarWidth(w);
    save({ sidebarWidth: w });
  }, [save]);

  const [sourceTabs, setSourceTabs] = useState<SourceTabsState>(EMPTY_SOURCE_TABS);
  const [decompiler, setDecompiler] = useState<DecompilerId>('vineflower');
  const [prettySource, setPrettySource] = useState(false);
  const [javaPage, setJavaPage] = useState<JavaPage>('method');
  const [requestTab, setRequestTab] = useState<RequestTab>('params');
  const onTogglePrettySource = useCallback(() => setPrettySource((p) => !p), []);
  const onOpenClass = useCallback((req: OpenTabRequest) => setSourceTabs((s) => openSourceTab(s, req)), []);
  const onSelectSourceTab = useCallback((id: string) => setSourceTabs((s) => selectSourceTab(s, id)), []);
  const onCloseSourceTab = useCallback((id: string) => setSourceTabs((s) => closeSourceTab(s, id)), []);
  const onCloseAllSourceTabs = useCallback(() => setSourceTabs((s) => closeAllSourceTabs(s)), []);
  const onUndoSourceTabs = useCallback(() => setSourceTabs((s) => undoCloseSourceTabs(s)), []);
  const onResolveSourceTab = useCallback((tabId: string, resolved: string) => setSourceTabs((s) => resolveSourceTab(s, tabId, resolved)), []);
  const onMinimizeSourceDialog = useCallback(() => setSourceTabs((s) => minimizeSourceDialog(s)), []);
  const onSourceBack = useCallback(() => setSourceTabs((s) => navigateSourceBack(s)), []);
  const onSourceForward = useCallback(() => setSourceTabs((s) => navigateSourceForward(s)), []);
  const onRecordSourceLoc = useCallback((entry: SourceNavEntry) => setSourceTabs((s) => recordSourceLocation(s, entry)), []);
  const onToggleSourceDialog = useCallback(
    () => setSourceTabs((s) => (s.open ? minimizeSourceDialog(s) : showSourceDialog(s))),
    [],
  );

  const routeState = useRef<RouteState>(parseState(location.search));
  const [selectedKey, setSelectedKey] = useState<string | undefined>(routeState.current.op);
  const drafts = useRef(new Map<string, Draft>());
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const onPop = () => {
      const state = (routeState.current = parseState(location.search));
      const refill = !!state.op && (Object.keys(state.path).length > 0 || Object.keys(state.q).length > 0
        || Object.keys(state.h).length > 0 || Object.keys(state.form ?? {}).length > 0);
      if (state.op !== selectedRef.current || refill) runner.abort();
      if (refill) {
        drafts.current.delete(state.op!);
        setRevision((r) => r + 1);
      }
      setSelectedKey(state.op);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [runner]);

  const selectedRef = useRef(selectedKey);
  selectedRef.current = selectedKey;
  const select = useCallback((op: Operation, urlMatch?: RouteMatch) => {
    const hasPrefill = !!urlMatch && (Object.keys(urlMatch.values).length > 0 || Object.keys(urlMatch.query).length > 0);
    if (op.key !== selectedRef.current || hasPrefill) runner.abort();
    setSelectedKey(op.key);
    routeState.current = {
      op: op.key,
      path: urlMatch ? { ...urlMatch.values } : {},
      q: urlMatch ? { ...urlMatch.query } : {},
      h: {},
    };
    if (hasPrefill) {
      drafts.current.delete(op.key);
      setRequestTab('params');
      setRevision((r) => r + 1);
    }
    const url = location.pathname + formatState(routeState.current);
    if (location.pathname + location.search !== url) history.pushState(null, '', url);
  }, [runner]);

  const selectFromSourceDialog = useCallback((targetOp: Operation) => {
    select(targetOp);
    setSourceTabs((s) => minimizeSourceDialog(s));
  }, [select]);

  const withResult = useRef<string[]>([]);
  const onDraft = useCallback((key: string, d: Draft) => {
    drafts.current.set(key, d);
    if (d.result) {
      withResult.current = [key, ...withResult.current.filter((k) => k !== key)];
      for (const old of withResult.current.splice(KEEP_RESPONSES)) {
        const draft = drafts.current.get(old);
        if (draft) drafts.current.set(old, { ...draft, result: null });
      }
    } else {
      withResult.current = withResult.current.filter((k) => k !== key);
    }
  }, []);

  // Stable ref-backed getter preserves memo(OperationView) across unrelated App renders (sidebar search, dialogs).
  const getInitialDraft = useCallback((targetOp: Operation): Draft => {
    let d = drafts.current.get(targetOp.key);
    if (!d) {
      d = prefill(targetOp, emptyDraft(targetOp), routeState.current);
      drafts.current.set(targetOp.key, d);
    }
    return d;
  }, []);

  const lastOp = useRef<Operation | undefined>(undefined);
  let op = selectedKey ? opsByKey.get(selectedKey) : undefined;
  if (!op && selectedKey && lastOp.current?.key === selectedKey && summary && !summary.complete) op = lastOp.current;
  lastOp.current = op;

  const root = useRef<HTMLDivElement>(null);
  const bodyRowRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(600);
  const [rowWidth, setRowWidth] = useState(1200);
  useLayoutEffect(() => {
    const measure = () => {
      const top = root.current ? root.current.getBoundingClientRect().top + window.scrollY : 0;
      const viewport = document.documentElement.clientHeight || window.innerHeight;
      setHeight(Math.max(420, viewport - top - 1));
      setRowWidth(bodyRowRef.current?.clientWidth || window.innerWidth || 1200);
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('load', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(document.body);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('load', measure);
      observer?.disconnect();
    };
  }, []);

  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | undefined>();
  const shownCollapsedRef = useRef(shownCollapsed);
  shownCollapsedRef.current = shownCollapsed;
  const onStart = useCallback((m: Module) => {
    setRefreshError(undefined);
    if (shownCollapsedRef.current.has(m.id)) {
      const next = new Set(shownCollapsedRef.current);
      next.delete(m.id);
      onCollapsed(next);
    }
    store.startModule(m).catch((e: unknown) => {
      if (mountedRef.current && !(e instanceof StartStopped) && !isSessionExpired(e)) {
        setRefreshError(`Could not start ${m.path}: ${errMsg(e)}`);
      }
    });
  }, [store, onCollapsed]);

  useEffect(() => {
    if (!refreshError) return;
    const t = setTimeout(() => setRefreshError(undefined), 10_000);
    return () => clearTimeout(t);
  }, [refreshError]);

  const refresh = useCallback(async () => {
    setRefreshError(undefined);
    setRefreshing(true);
    clearDetails();
    try {
      await store.rebuild();
    } catch (e) {
      if (mountedRef.current && !isSessionExpired(e)) setRefreshError(errMsg(e));
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }, [store]);

  const linkWaiting = selectedKey && !op && !loadError
    ? summary?.modules.find((m) => selectedKey.startsWith(m.id + ':') && isWaiting(m)) : undefined;
  const productLabel = summary ? `${summary.product.name} ${summary.product.version}` : product;
  const maxSidebarW = Math.round(Math.max(MIN_SIDEBAR, rowWidth * MAX_SIDEBAR));
  const shownSidebarW = Math.min(maxSidebarW, Math.max(MIN_SIDEBAR, liveSidebarWidth ?? sidebarWidth));

  return (
    <div class="rab-n" ref={root} style={{ height: height + 'px' }} data-skin={skin}>
      <TopBar
        product={product}
        productLabel={productLabel}
        version={version}
        siteUrl={siteUrl}
        classicUrl={classicUrl}
        sysadmin={!!summary?.sysadmin}
        catalogComplete={!!summary?.complete}
        refreshing={refreshing}
        operationsCount={rows.length}
        modulesCount={summary?.modules.length}
        sourceDialogOpen={sourceTabs.open}
        sourceTabsCount={sourceTabs.tabs.length}
        skin={skin}
        mode={mode}
        onModeChange={onModeChange}
        onSkinChange={onSkinChange}
        onResetLayout={onResetLayout}
        onRebuildCatalog={refresh}
        onToggleSourceDialog={onToggleSourceDialog}
      />
      <div ref={bodyRowRef} class="rab-n-body-row">
        <div class="rab-n-side" style={{ width: shownSidebarW + 'px' }}>
          <MemoSidebar
            summary={summary}
            rows={rows}
            matcher={matcher}
            selectedKey={selectedKey}
            onSelect={select}
            query={query}
            onQuery={setQuery}
            supportedOnly={supportedOnly}
            onSupportedOnly={onSupportedOnly}
            collapsed={shownCollapsed}
            onCollapsed={onCollapsed}
            loadError={loadError ?? refreshError}
            onStart={onStart}
            starting={starting}
            startFailures={startFailures}
          />
        </div>
        <SplitHandle
          className="rab-n-vsplit"
          orientation="vertical"
          label="Resize the list"
          value={shownSidebarW}
          min={MIN_SIDEBAR}
          max={maxSidebarW}
          step={20}
          bigStep={80}
          onChange={setLiveSidebarWidth}
          onCommit={onCommitSidebarWidth}
        />
        <div class="rab-n-main">
          {op && summary ? (
            <MemoOperation
              key={op.key + ':' + revision}
              summary={summary}
              op={op}
              module={modulesById.get(op.module)}
              getInitialDraft={getInitialDraft}
              onDraft={onDraft}
              runner={runner}
              userStore={userStore}
              split={split}
              onSplit={onSplit}
              onOpenClass={summary.sysadmin ? onOpenClass : undefined}
              decompiler={decompiler}
              onDecompiler={setDecompiler}
              prettySource={prettySource}
              onTogglePrettySource={onTogglePrettySource}
              javaPage={javaPage}
              onJavaPage={setJavaPage}
              tab={requestTab}
              onTab={setRequestTab}
            />
          ) : (
            <Welcome
              summary={summary}
              missing={!!selectedKey && !!index && !op && !!summary?.complete && !linkWaiting}
              indexing={!!selectedKey && !op && !loadError && !summary?.complete && !linkWaiting}
              linkWaiting={linkWaiting}
              linkStarting={!!linkWaiting && starting.has(linkWaiting.id)}
              linkFailure={linkWaiting && startFailures.get(linkWaiting.id)?.message}
              onStart={onStart}
            />
          )}
        </div>
      </div>
      {summary?.sysadmin && (
        <SourceDialog
          baseUrl={summary.baseUrl}
          state={sourceTabs}
          decompiler={decompiler}
          onDecompiler={setDecompiler}
          pretty={prettySource}
          onPretty={onTogglePrettySource}
          outlineWidth={outlineWidth}
          onOutlineWidth={onOutlineWidth}
          operations={index?.operations}
          modulesById={modulesById}
          onSelectTab={onSelectSourceTab}
          onCloseTab={onCloseSourceTab}
          onCloseAll={onCloseAllSourceTabs}
          onUndo={onUndoSourceTabs}
          onOpenClass={onOpenClass}
          onResolveTab={onResolveSourceTab}
          onMinimize={onMinimizeSourceDialog}
          canBack={canNavigateSourceBack(sourceTabs)}
          canForward={canNavigateSourceForward(sourceTabs)}
          onBack={onSourceBack}
          onForward={onSourceForward}
          onRecordLocation={onRecordSourceLoc}
          onSelectOperation={selectFromSourceDialog}
        />
      )}
      <ClassHoverCard
        baseUrl={summary?.baseUrl ?? baseUrl}
        enabled={!!summary?.sysadmin}
        rootRef={root}
        onOpenClass={onOpenClass}
      />
      <UiTipLayer rootRef={root} />
    </div>
  );
}
