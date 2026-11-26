import { useRef } from 'preact/hooks';
import { memo } from 'preact/compat';
import { issueBody, REPO } from '../core/prefill';
import { PRODUCT_MODE, SKINS, type Mode } from '../core/theme';
import { tipProps } from '../core/uitips';
import { PinHint, plural, safeHref, useTip } from './bits';
import { Menu, type MenuItem } from './Menu';

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

function BrandIcon({ size }: { size: number }) {
  return (
    <svg class="rab-n-svg" width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M5.5 3.5L2.5 8l3 4.5M10.5 3.5L13.5 8l-3 4.5M9 2.5L7 13.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

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
      <a class="rab-n-about-foot" href={REPO} target="_blank" rel="noopener noreferrer" tabIndex={pinned ? 0 : -1} aria-hidden={!pinned || undefined}>
        <svg class="rab-n-svg" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M9 3h4v4M13 3L7.5 8.5M11.5 9.5V13h-8.5V4.5H6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        github.com/rdk/rest-api-browser
      </a>
      <PinHint pinned={pinned} clickable />
    </div>
  );
}

export interface TopBarProps {
  product: string;
  productLabel: string;
  version: string;
  siteUrl: string;
  classicUrl: string;
  sysadmin: boolean;
  catalogComplete: boolean;
  refreshing: boolean;
  operationsCount: number;
  modulesCount?: number;
  sourceDialogOpen: boolean;
  sourceTabsCount: number;
  skin: string;
  mode: Mode | null;
  onModeChange: (m: Mode) => void;
  onSkinChange: (s: string) => void;
  onResetLayout: () => void;
  onRebuildCatalog: () => void;
  onToggleSourceDialog: () => void;
}

export const TopBar = memo(function TopBar(p: TopBarProps) {
  const brandWrap = useRef<HTMLSpanElement>(null);
  const about = useTip(brandWrap, true);
  const site = p.siteUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
  const siteHost = site.split('/')[0];
  const safeSiteUrl = safeHref(p.siteUrl);

  const menu: MenuItem[] = [
    {
      id: 'layout',
      label: 'Reset the layout',
      hint: 'The width of the list and the request/response split',
      onSelect: p.onResetLayout,
    },
    ...(p.sysadmin
      ? [{
          id: 'rebuild',
          label: 'Rebuild the catalog',
          hint: p.catalogComplete && !p.refreshing ? 'Reads every REST module again (system administrators)' : 'The catalog is being built…',
          disabled: !p.catalogComplete || p.refreshing,
          onSelect: p.onRebuildCatalog,
          testId: 'refresh',
          group: true,
        }]
      : []),
    {
      id: 'mode',
      label: 'Colour mode',
      section: 'Theme',
      group: true,
      choices: (['light', 'dark', 'system'] as Mode[]).map((m) => {
        const label = m === 'light' ? 'Light' : m === 'dark' ? 'Dark' : 'System';
        return {
          id: m,
          label,
          icon: MODE_ICONS[m],
          checked: (p.mode ?? PRODUCT_MODE) === m,
          testId: 'mode-' + m,
          tip: {
            title: `${label} colour mode`,
            body: m === 'light'
              ? 'Always use the light colour palette on this page.'
              : m === 'dark'
                ? 'Always use the dark colour palette on this page.'
                : 'Follow your operating system or browser colour scheme automatically.',
          },
          onSelect: () => p.onModeChange(m),
        };
      }),
    },
    ...SKINS.map((k) => ({
      id: 'skin-' + k.id,
      label: k.label,
      hint: k.hint,
      checked: p.skin === k.id,
      keepOpen: true,
      testId: 'skin-' + k.id,
      onSelect: () => p.onSkinChange(k.id),
    })),
    {
      id: 'report',
      label: 'Report an issue…',
      hint: 'A new issue on GitHub, with the versions filled in',
      href: `${REPO}/issues/new?body=${encodeURIComponent(issueBody(p.version, p.productLabel))}`,
      newTab: true,
      testId: 'report-issue',
      group: true,
    },
  ];

  return (
    <div class="rab-n-topbar">
      <div class="rab-n-top-left">
        <span ref={brandWrap} class={'rab-n-brand-wrap' + about.state} onMouseEnter={about.onMouseEnter} onFocusIn={about.onFocusIn}>
          <button
            type="button"
            class="rab-n-brand"
            aria-describedby="rab-n-about"
            aria-pressed={about.pinned}
            data-testid="brand"
            onClick={about.onTargetClick}
          >
            <span class="rab-n-brand-mark" aria-hidden="true">
              <BrandIcon size={15} />
            </span>
            <strong class="rab-n-topbar-title">REST API Browser</strong>
          </button>
          <About version={p.version} product={p.productLabel} operations={p.operationsCount} modules={p.modulesCount} pinned={about.pinned} />
        </span>
        {p.version && (
          <a
            class="rab-n-version"
            href={`${REPO}/releases`}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="version"
            {...tipProps({
              title: `Version ${p.version}`,
              body: 'Open release notes and download history on GitHub in a new tab.',
            })}
          >
            v{p.version}
          </a>
        )}
      </div>
      <div class="rab-n-top-center">
        {site && (
          <a
            class="rab-n-site"
            href={safeSiteUrl}
            target={safeSiteUrl ? '_blank' : undefined}
            rel={safeSiteUrl ? 'noopener noreferrer' : undefined}
            data-testid="site"
            {...tipProps({
              title: `${p.product || 'Product'} base URL`,
              body: `Open ${p.siteUrl} in a new tab. All REST requests run against this instance.`,
            })}
          >
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
        {p.sysadmin && (
          <button
            type="button"
            class="rab-n-top-link rab-n-top-classes"
            onClick={p.onToggleSourceDialog}
            aria-expanded={p.sourceDialogOpen}
            data-testid="open-classes-dialog"
            {...tipProps({
              title: 'Decompiled Java classes',
              body: p.sourceDialogOpen
                ? 'Hide the floating decompiler window while keeping your open class tabs.'
                : 'Open the floating tabbed Java decompiler window to browse and inspect classes.',
              note: p.sourceTabsCount > 0 ? `${plural(p.sourceTabsCount, 'open class tab')}` : undefined,
            })}
          >
            <svg class="rab-n-svg" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M5.5 4.2L2 8l3.5 3.8M10.5 4.2L14 8l-3.5 3.8M9 3.2L7 12.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Classes
            {p.sourceTabsCount > 0 && (
              <span class="rab-n-top-badge" data-testid="classes-tab-count">{p.sourceTabsCount}</span>
            )}
          </button>
        )}
        {p.classicUrl && (
          <a
            class="rab-n-top-link"
            href={p.classicUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="classic-link"
            {...tipProps({
              title: 'Classic UI',
              body: 'Open the original AngularJS / WADL-based REST API Browser in a new tab.',
            })}
          >
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
  );
});
