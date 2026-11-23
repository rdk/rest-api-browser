import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import type { Index, Module, Operation, Summary } from '../core/types';
import { CatalogStore } from '../core/catalog';
import { clearDetails } from '../core/details';
import { buildRows } from '../core/search';
import { formatState, parseState, type RouteState } from '../core/router';
import { findTemplates } from '../core/template';
import { RequestRunner } from './runner';
import { UserStore, isCredentialHeader } from './userstore';
import { Sidebar } from './Sidebar';
import { OperationView, emptyDraft, type Draft } from './Operation';
import { Menu, type MenuItem } from './Menu';
import { PinHint, plural, usePin } from './bits';
import { isSkipped, isWaiting } from './facts';

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

/** The skins of skins.css, in the menu's order; the first is the default. */
const SKINS = [
  { id: 'balanced', label: 'Balanced', hint: 'Blue to indigo, soft gradients' },
  { id: 'vivid', label: 'Vivid', hint: 'Bold gradients in many colours' },
  { id: 'navy', label: 'Calm', hint: 'Flat and quiet, a deep navy header' },
];
/** A stored skin, or the default; "calm" (a light header, dropped) becomes the navy one. */
const skinOf = (s: string | undefined) => (s === 'calm' ? 'navy' : SKINS.some((k) => k.id === s) ? s! : SKINS[0].id);

type Mode = 'light' | 'dark' | 'system';
/**
 * The product's own colour mode when the page loaded, before any choice here: its <html> carries data-color-mode
 * (light or dark) and, when it follows the system, data-color-mode-auto. Read once, at load.
 */
const PRODUCT_MODE: Mode = (() => {
  const h = typeof document !== 'undefined' ? document.documentElement : null;
  if (!h) return 'light';
  if (h.hasAttribute('data-color-mode-auto')) return 'system';
  return h.getAttribute('data-color-mode') === 'dark' ? 'dark' : 'light';
})();
const isMode = (m: unknown): m is Mode => m === 'light' || m === 'dark' || m === 'system';

/**
 * Applies a colour mode to this page: the product's design tokens switch on <html>'s data-color-mode (both its light
 * and dark themes are loaded), "system" follows the browser's preference and its changes. Returns the clean-up.
 */
function applyMode(mode: Mode): () => void {
  const h = document.documentElement;
  const themes = (h.getAttribute('data-theme') ?? '').split(/\s+/).filter(Boolean);
  for (const t of ['dark:dark', 'light:light']) if (!themes.includes(t)) themes.push(t);
  if (h.getAttribute('data-theme') !== themes.join(' ')) h.setAttribute('data-theme', themes.join(' '));
  if (mode !== 'system') {
    h.removeAttribute('data-color-mode-auto');
    h.setAttribute('data-color-mode', mode);
    return () => undefined;
  }
  const media = matchMedia('(prefers-color-scheme: dark)');
  const follow = () => h.setAttribute('data-color-mode', media.matches ? 'dark' : 'light');
  h.setAttribute('data-color-mode-auto', '');
  follow();
  media.addEventListener('change', follow);
  return () => media.removeEventListener('change', follow);
}

const MODE_ICONS: Record<Mode, preact.JSX.Element> = {
  light: (
    <svg class="rab-n-svg" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  dark: (
    <svg class="rab-n-svg" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13.2 9.6A5.6 5.6 0 016.4 2.8a5.6 5.6 0 106.8 6.8z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  ),
  system: (
    <svg class="rab-n-svg" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 14h5M8 11v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
};

/** The project's home, its releases and its issues. */
const REPO = 'https://github.com/rdk/rest-api-browser';

const MemoSidebar = memo(Sidebar);
const MemoOperation = memo(OperationView);
const NONE = new Set<string>();
const KEEP_RESPONSES = 5;
const SIDEBAR_WIDTH = 430;
const SPLIT = 0.45;
/** The list may take up to this share of the width. */
const MAX_SIDEBAR = 0.75;

export function App({ baseUrl, classicUrl, product, version, siteUrl, user }: Props) {
  const store = useMemo(() => new CatalogStore(baseUrl), [baseUrl]);
  const runner = useMemo(() => new RequestRunner(), []);
  const userStore = useMemo(() => new UserStore(baseUrl || location.host, user || undefined), [baseUrl, user]);

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
    let live = true; // a store replaced before its first load ends must not write over the new one
    store.load().then(() => live && sync(), (e) => live && setLoadError(describeError(e)));
    return () => {
      live = false;
      off();
      store.stop();
    };
  }, [store]);

  // a catalog that changed (rebuilt, an app upgraded) may have other Java behind the same operations
  const hash = summary?.hash;
  const lastHash = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (hash && lastHash.current && hash !== lastHash.current) clearDetails();
    if (hash) lastHash.current = hash;
  }, [hash]);

  const rows = useMemo(() => (summary && index ? buildRows(summary, index) : []), [summary, index]);
  const opsByKey = useMemo(() => new Map((index?.operations ?? []).map((o) => [o.key, o])), [index]);
  const modulesById = useMemo(() => new Map((summary?.modules ?? []).map((m) => [m.id, m])), [summary]);

  // ---- preferences, read at once: the first paint already has the user's skin, colour mode and layout
  const stored = useMemo(() => userStore.prefsNow(), [userStore]);
  const [query, setQuery] = useState('');
  const [supportedOnly, setSupportedOnly] = useState(!!stored.supportedOnly);
  const [collapsed, setCollapsed] = useState<Set<string> | null>(stored.collapsed ? new Set(stored.collapsed) : null);
  const [sidebarWidth, setSidebarWidth] = useState(stored.sidebarWidth || SIDEBAR_WIDTH);
  const [split, setSplit] = useState(stored.split || SPLIT);
  const [skin, setSkin] = useState(skinOf(stored.skin));
  // the colour mode: the product's until the user chooses one here; applied before the browser paints
  const [mode, setMode] = useState<Mode | null>(isMode(stored.mode) ? stored.mode : null);
  useLayoutEffect(() => (mode ? applyMode(mode) : undefined), [mode]);
  // first visit: only the product's supported modules start expanded, from the first paint that has the modules
  // (shownCollapsed) until the user folds or unfolds one (collapsed is set then)
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

  // ---- selection, kept in the URL (?op=...)
  const routeState = useRef<RouteState>(parseState(location.search));
  const [selectedKey, setSelectedKey] = useState<string | undefined>(routeState.current.op);
  const drafts = useRef(new Map<string, Draft>());
  // bumped when Back or Forward lands on a link with values: the form is filled from it again, as when it was opened
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const onPop = () => {
      const state = (routeState.current = parseState(location.search));
      const refill = !!state.op && (Object.keys(state.path).length > 0 || Object.keys(state.q).length > 0 || Object.keys(state.h).length > 0);
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
    } else {
      withResult.current = withResult.current.filter((k) => k !== key);
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
      // the viewport without the page's own scrollbars (clientHeight), so a horizontal one never hides the list's end
      const viewport = document.documentElement.clientHeight || window.innerHeight;
      setHeight(Math.max(420, viewport - top - 1));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('load', measure);
    // the product can add something above the app after it rendered (a banner, its navigation): measure again then,
    // or the list's last rows would sit below the window, out of reach
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(document.body);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('load', measure);
      observer?.disconnect();
    };
  }, []);

  // modules being started (Confluence starts a module's REST API on its first request): a click in the list
  const [starting, setStarting] = useState<Set<string>>(() => new Set());
  const collapsedRef = useRef(shownCollapsed);
  collapsedRef.current = shownCollapsed;
  const onStart = useCallback((m: Module) => {
    setStarting((s) => (s.has(m.id) ? s : new Set(s).add(m.id)));
    store.startModule(m).then(
      () => {
        // read: show its operations at once
        const next = new Set(collapsedRef.current);
        if (next.delete(m.id)) onCollapsed(next);
      },
      (e) => setRefreshError(`Could not start ${m.path}: ${e instanceof Error ? e.message : String(e)}`),
    ).finally(() => setStarting((s) => {
      const next = new Set(s);
      next.delete(m.id);
      return next;
    }));
  }, [store, onCollapsed]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | undefined>();
  // a failed rebuild says so in the list's status line for a while, then the counts come back
  useEffect(() => {
    if (!refreshError) return;
    const t = setTimeout(() => setRefreshError(undefined), 10_000);
    return () => clearTimeout(t);
  }, [refreshError]);
  const refresh = useCallback(async () => {
    setRefreshError(undefined);
    setRefreshing(true);
    clearDetails();
    const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
    try {
      const res = await fetch(baseUrl + '/rest/restbrowser/1/catalog/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Atlassian-Token': 'no-check' },
      });
      if (!res.ok) {
        setRefreshError(res.status === 403 ? 'Only system administrators can rebuild the catalog.' : `The rebuild could not be started (HTTP ${res.status}).`);
        return;
      }
      try {
        await store.refreshSoon();
      } catch (e) {
        setRefreshError('The rebuild started, but the catalog could not be read again: ' + message(e));
      }
    } catch (e) {
      setRefreshError('The rebuild could not be started: ' + message(e));
    } finally {
      setRefreshing(false);
    }
  }, [baseUrl, store]);

  const productLabel = summary ? `${summary.product.name} ${summary.product.version}` : product;
  // the header's tooltip about the project: on hover or keyboard focus of the brand, pinned with Alt+P
  const brandWrap = useRef<HTMLSpanElement>(null);
  // Escape hides it even while the pointer rests on it (it comes back when the pointer or the focus comes back)
  const [aboutDismissed, setAboutDismissed] = useState(false);
  const dismissedRef = useRef(false);
  dismissedRef.current = aboutDismissed;
  const aboutShown = () => {
    const el = brandWrap.current;
    return !!el && !dismissedRef.current && !el.closest('[inert]') && (el.matches(':hover') || !!el.querySelector(':focus-visible'));
  };
  const aboutPinned = usePin(aboutShown, brandWrap, () => setAboutDismissed(true));
  useEffect(() => {
    // in the capture phase, and only when it hides the tooltip: then it is that Escape's only effect
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !aboutShown()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setAboutDismissed(true);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  const site = siteUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
  const siteHost = site.split('/')[0];
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
          hint: summary.complete && !refreshing ? 'Reads every REST module again (system administrators)' : 'The catalog is being built…',
          disabled: !summary.complete || refreshing,
          onSelect: refresh,
          testId: 'refresh',
          group: true,
        }]
      : []),
    {
      id: 'mode',
      label: 'Colour mode',
      section: 'Theme',
      group: true,
      choices: (['light', 'dark', 'system'] as Mode[]).map((m) => ({
        id: m,
        label: m === 'light' ? 'Light' : m === 'dark' ? 'Dark' : 'System',
        icon: MODE_ICONS[m],
        checked: (mode ?? PRODUCT_MODE) === m,
        testId: 'mode-' + m,
        onSelect: () => {
          setMode(m);
          save({ mode: m });
        },
      })),
    },
    ...SKINS.map((k) => ({
      id: 'skin-' + k.id,
      label: k.label,
      hint: k.hint,
      checked: skin === k.id,
      keepOpen: true,
      testId: 'skin-' + k.id,
      onSelect: () => {
        setSkin(k.id);
        save({ skin: k.id });
      },
    })),
    {
      id: 'report',
      label: 'Report an issue…',
      hint: 'A new issue on GitHub, with the versions filled in',
      href: `${REPO}/issues/new?body=${encodeURIComponent(issueBody(version, productLabel))}`,
      newTab: true,
      testId: 'report-issue',
      group: true,
    },
  ];

  return (
    <div class="rab-n" ref={root} style={{ height: height + 'px' }} data-skin={skin}>
      <div class="rab-n-topbar">
        <div class="rab-n-top-left">
        <span ref={brandWrap} class={'rab-n-brand-wrap' + (aboutPinned ? ' pinned' : aboutDismissed ? ' dismissed' : '')}
              onMouseEnter={() => setAboutDismissed(false)} onFocusIn={() => setAboutDismissed(false)}>
          <a class="rab-n-brand" href={REPO} target="_blank" rel="noopener noreferrer" aria-describedby="rab-n-about" data-testid="brand">
            <span class="rab-n-brand-mark" aria-hidden="true">
              <BrandIcon size={15} />
            </span>
            <strong class="rab-n-topbar-title">REST API Browser</strong>
          </a>
          <About version={version} product={productLabel} operations={rows.length} modules={summary?.modules.length} pinned={aboutPinned} />
        </span>
        {version && (
          <a class="rab-n-version" href={`${REPO}/releases`} target="_blank" rel="noopener noreferrer"
             title="Releases and their notes on GitHub" data-testid="version">
            v{version}
          </a>
        )}
        </div>
        <div class="rab-n-top-center">
          {site && (
            <a class="rab-n-site" href={siteUrl} target="_blank" rel="noopener noreferrer"
               title={`${product || 'The product'}'s base URL: ${siteUrl} (opens in a new tab)`} data-testid="site">
              <svg class="rab-n-svg" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="5.8" stroke="currentColor" strokeWidth="1.3" />
                <path d="M2.4 8h11.2M8 2.2c1.7 1.6 2.5 3.6 2.5 5.8S9.7 12.2 8 13.8M8 2.2C6.3 3.8 5.5 5.8 5.5 8s.8 4.2 2.5 5.8" stroke="currentColor" strokeWidth="1.2" />
              </svg>
              <span class="rab-n-site-host">{siteHost}</span>
              {site.length > siteHost.length && <span class="rab-n-site-path">{site.slice(siteHost.length)}</span>}
            </a>
          )}
        </div>
        <div class="rab-n-top-right">
        {classicUrl && (
          <a class="rab-n-top-link" href={classicUrl} title="The original REST API Browser" data-testid="classic-link">
            <svg class="rab-n-svg" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M6 3v10" stroke="currentColor" strokeWidth="1.4" />
            </svg>
            Classic UI
          </a>
        )}
        <Menu label="More actions" items={menu} />
        </div>
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
            collapsed={shownCollapsed}
            onCollapsed={onCollapsed}
            loadError={loadError ?? refreshError}
            onStart={onStart}
            starting={starting}
          />
        </div>
        <SideHandle width={sidebarWidth} onWidth={setSidebarWidth} onDone={(w) => save({ sidebarWidth: w })} />
        <div class="rab-n-main">
          {op && draft && summary ? (
            <MemoOperation
              key={op.key + ':' + revision}
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
              indexing={!!selectedKey && !op && !loadError && !summary?.complete}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function BrandIcon({ size }: { size: number }) {
  return (
    <svg class="rab-n-svg" width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M5.5 3.5L2.5 8l3 4.5M10.5 3.5L13.5 8l-3 4.5M9 2.5L7 13.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The header's tooltip about the project; the brand it describes opens the project on GitHub. */
function About({ version, product, operations, modules, pinned }: {
  version: string; product: string; operations: number; modules?: number; pinned: boolean;
}) {
  return (
    <div id="rab-n-about" class="rab-n-about" role="tooltip" data-testid="about">
      <div class="rab-n-about-head">
        <span class="rab-n-about-mark" aria-hidden="true"><BrandIcon size={18} /></span>
        <span>
          <span class="rab-n-about-title">REST API Browser</span>
          {version && <span class="rab-n-about-version">Version {version}</span>}
        </span>
      </div>
      <p class="rab-n-about-text">
        Browse and try the REST APIs of this product: its own, those of its bundled apps and those of the apps you
        installed. Requests run in your browser, with your session.
      </p>
      <dl class="rab-n-card-facts">
        {product && (
          <>
            <dt>Running on</dt>
            <dd>{product}</dd>
          </>
        )}
        {modules !== undefined && operations > 0 && (
          <>
            <dt>Catalog</dt>
            <dd>{plural(operations, 'operation')} in {plural(modules, 'module')}</dd>
          </>
        )}
        <dt>Project</dt>
        <dd>An unofficial fork of Atlassian's archived REST API Browser</dd>
        <dt>License</dt>
        <dd>Apache License 2.0</dd>
      </dl>
      <a class="rab-n-about-foot" href={REPO} target="_blank" rel="noopener noreferrer" tabIndex={-1} aria-hidden="true">
        <svg class="rab-n-svg" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M9 3h4v4M13 3L7.5 8.5M11.5 9.5V13h-8.5V4.5H6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Click to open github.com/rdk/rest-api-browser
      </a>
      <PinHint pinned={pinned} />
    </div>
  );
}

/** The body of a new GitHub issue: the questions, and the versions that help to reproduce it. */
function issueBody(version: string, product: string): string {
  return [
    '**What happened?**', '', '', '**What did you expect?**', '', '', '**Steps to reproduce**', '', '', '---',
    `REST API Browser ${version || '(version unknown)'}, new UI, on ${product || '(product unknown)'}`,
  ].join('\n');
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
  // modules left out on purpose (excluded, REST v1) are not failures
  const failed = summary ? summary.modules.filter((m) => m.state === 'failed' && !isSkipped(m) && !isWaiting(m)).length : 0;
  const waiting = summary ? summary.modules.filter(isWaiting).length : 0;
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
        {waiting > 0 && (
          <p class="rab-n-subtle rab-n-welcome-note" data-testid="waiting-note">
            {plural(waiting, 'module')} {waiting === 1 ? 'has' : 'have'} not started yet on this node: the product starts a module's REST
            API on its first request. Click one in the list to start it and see its operations.
          </p>
        )}
        {failed > 0 && (
          <p class="rab-n-subtle rab-n-welcome-note">
            {plural(failed, 'module')} could not be described; {failed === 1 ? 'it is' : 'they are'} listed with the reason.
          </p>
        )}
      </div>
    </div>
  );
}

function SideHandle({ width, onWidth, onDone }: { width: number; onWidth: (w: number) => void; onDone: (w: number) => void }) {
  // the keyboard resizes too: Tab to the divider, then the arrow keys
  const maxOf = (row: HTMLElement | null | undefined) => Math.max(240, row ? row.clientWidth * MAX_SIDEBAR : Infinity);
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const next = Math.round(Math.min(maxOf(ref.current?.parentElement), Math.max(240, width + (e.key === 'ArrowRight' ? 20 : -20))));
    onWidth(next);
    onDone(next);
  };
  const ref = useRef<HTMLDivElement>(null);
  const stop = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stop.current?.(), []);
  // the range for assistive technology follows the window's width
  const [rowWidth, setRowWidth] = useState(0);
  useLayoutEffect(() => {
    const measure = () => setRowWidth(ref.current?.parentElement?.clientWidth ?? 0);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  const onDown = (e: PointerEvent) => {
    const row = ref.current?.parentElement;
    const side = row?.firstElementChild as HTMLElement | null;
    if (!row || !side || e.button !== 0) return;
    e.preventDefault();
    stop.current?.();
    const left = row.getBoundingClientRect().left;
    let last = 0;
    // resize the element directly while dragging; the state (and a re-render) follows once, on release
    const move = (ev: PointerEvent) => {
      last = Math.round(Math.min(maxOf(row), Math.max(240, ev.clientX - left)));
      side.style.width = last + 'px';
    };
    const detach = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      stop.current = undefined;
    };
    const up = () => {
      detach();
      if (last) {
        onWidth(last);
        onDone(last);
      }
    };
    stop.current = detach;
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  };
  return (
    <div ref={ref} class="rab-n-vsplit" onPointerDown={onDown} onKeyDown={onKeyDown} tabIndex={0}
         role="separator" aria-orientation="vertical" aria-label="Resize the list" aria-valuenow={width}
         aria-valuemin={240} aria-valuemax={rowWidth ? Math.round(Math.max(240, rowWidth * MAX_SIDEBAR)) : undefined} />
  );
}
