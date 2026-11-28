import { useEffect, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import type { RefObject } from 'preact';
import type { ClosedSnapshot, SourceTab } from '../../core/sourcetabs';
import type { ResizeDir } from '../../core/sourcewindow';
import { tipProps } from '../../core/uitips';
import { formatBytes, MaximizeButton, plural } from '../bits';
import type { LineTracker, TabMeta } from './SourceTabPane';

export const RESIZE_DIRS: { dir: ResizeDir; testId?: string }[] = [
  { dir: 'n' }, { dir: 's' }, { dir: 'e' }, { dir: 'w' },
  { dir: 'ne' }, { dir: 'nw' }, { dir: 'sw' }, { dir: 'se', testId: 'source-dialog-resize-se' },
];

/** Isolated status bar leaf: line-number updates during scroll never re-render SourceDialog or ClassOutline. */
export const StatusBar = memo(function StatusBar({
  tabCount,
  hasActive,
  meta,
  lineTracker,
}: {
  tabCount: number;
  hasActive: boolean;
  meta: TabMeta | null;
  lineTracker: LineTracker;
}) {
  const [line, setLine] = useState(() => lineTracker.current());
  useEffect(() => {
    setLine(lineTracker.current());
    return lineTracker.subscribe(setLine);
  }, [lineTracker, meta]);

  const pct = meta && meta.totalLines > 0 ? Math.min(100, Math.round((line / meta.totalLines) * 100)) : 0;

  return (
    <div class="rab-n-modal-status" data-testid="source-dialog-status">
      {hasActive && meta ? (
        <>
          <span class="rab-n-modal-stat" data-testid="source-dialog-pos">
            Line {line.toLocaleString()} / {meta.totalLines.toLocaleString()} ({pct}%)
          </span>
          <span class="rab-n-modal-stat-sep" aria-hidden="true">·</span>
          <span class="rab-n-modal-stat">{plural(meta.methods, 'method')}</span>
          <span class="rab-n-modal-stat-sep" aria-hidden="true">·</span>
          <span class="rab-n-modal-stat">{plural(meta.refs, 'class ref')}</span>
          <span class="rab-n-modal-stat-sep" aria-hidden="true">·</span>
          <span class="rab-n-modal-stat">{formatBytes(meta.bytes)}</span>
          {meta.bundleId !== undefined && meta.bundleId >= 0 && (
            <>
              <span class="rab-n-modal-stat-sep" aria-hidden="true">·</span>
              <span class="rab-n-modal-stat">OSGi bundle #{meta.bundleId}</span>
            </>
          )}
          <span class="rab-n-spacer" />
          <span class="rab-n-modal-stat">
            {meta.decompiler} ({meta.cached ? 'cached' : meta.decompileMs !== undefined ? `${meta.decompileMs} ms` : 'ready'})
          </span>
          <span class="rab-n-modal-stat-sep" aria-hidden="true">·</span>
          <span class="rab-n-modal-stat">{plural(tabCount, 'tab')}</span>
        </>
      ) : (
        <>
          <span class="rab-n-modal-stat">Ready</span>
          <span class="rab-n-spacer" />
          <span class="rab-n-modal-stat">{plural(tabCount, 'tab')}</span>
        </>
      )}
    </div>
  );
});

export function SourceDialogHeader({
  tabs,
  active,
  tabstripRef,
  showOpenInput,
  zipping,
  zipFlash,
  lastUndo,
  maximized,
  onStartDrag,
  onToggleMaximize,
  onTabListKeyDown,
  onTabStripWheel,
  onSelectTab,
  onCloseTab,
  onToggleOpenInput,
  onDownloadAllZip,
  onUndo,
  onCloseAll,
  onMinimize,
}: {
  tabs: SourceTab[];
  active: SourceTab | undefined;
  tabstripRef: RefObject<HTMLDivElement | null>;
  showOpenInput: boolean;
  zipping: boolean;
  zipFlash: 'idle' | 'done' | 'failed';
  lastUndo: ClosedSnapshot | undefined;
  maximized: boolean;
  onStartDrag: (e: PointerEvent) => void;
  onToggleMaximize: () => void;
  onTabListKeyDown: (e: KeyboardEvent) => void;
  onTabStripWheel: (e: WheelEvent) => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onToggleOpenInput: () => void;
  onDownloadAllZip: () => void;
  onUndo: () => void;
  onCloseAll: () => void;
  onMinimize: () => void;
}) {
  return (
    <div
      class="rab-n-modal-tabs"
      data-testid="source-dialog-header"
      onPointerDown={onStartDrag}
      onDblClick={(e) => {
        if (!(e.target as HTMLElement | null)?.closest('button, input')) onToggleMaximize();
      }}
    >
      <span class="rab-n-modal-grip" title="Drag to move, double-click to maximize" aria-hidden="true">⋮⋮</span>
      <div
        ref={tabstripRef}
        class="rab-n-modal-tabstrip"
        role="tablist"
        aria-label="Open Java classes"
        onKeyDown={onTabListKeyDown}
        onWheel={onTabStripWheel}
      >
        {tabs.map((t) => {
          const selected = active && t.id === active.id;
          return (
            <div
              key={t.uid}
              class={'rab-n-modal-tab' + (selected ? ' on' : '')}
              data-testid="source-dialog-tab"
              data-class={t.id}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onCloseTab(t.id);
                }
              }}
            >
              <button
                type="button"
                id={`rab-n-src-tab-${t.uid}`}
                role="tab"
                aria-selected={!!selected}
                aria-controls="rab-n-source-tabpanel"
                tabIndex={selected ? 0 : -1}
                class="rab-n-modal-tab-btn"
                data-class-ref={t.id}
                data-class-open="true"
                data-class-candidates={t.candidates.join(',')}
                data-class-bundle={t.fromBundle !== undefined && t.fromBundle >= 0 ? String(t.fromBundle) : undefined}
                data-class-op={t.opKey}
                onClick={() => onSelectTab(t.id)}
              >
                {t.label}
              </button>
              <button
                type="button"
                class="rab-n-modal-tab-close"
                data-testid="source-dialog-tab-close"
                aria-label={`Close ${t.label}`}
                {...tipProps({ title: `Close ${t.label}`, body: 'Close this class tab (can be reopened with Undo).' })}
                onClick={(e) => { e.stopPropagation(); onCloseTab(t.id); }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        class={'rab-n-modal-hbtn rab-n-modal-add' + (showOpenInput ? ' on' : '')}
        data-testid="source-dialog-add"
        aria-label="Open Java class by name"
        onClick={onToggleOpenInput}
        {...tipProps({ title: 'Open class by name', body: 'Decompile any Java class by entering its fully qualified class name.' })}
      >
        +
      </button>
      <div class="rab-n-modal-win-tools">
        <button
          type="button"
          class={'rab-n-modal-hbtn' + (zipFlash === 'done' ? ' done' : zipFlash === 'failed' ? ' failed' : '')}
          data-testid="source-dialog-download-zip"
          disabled={tabs.length === 0 || zipping}
          onClick={onDownloadAllZip}
          {...tipProps({
            title: 'Download all as ZIP',
            body: `Export ${plural(tabs.length, 'open class', 'open classes')} as .java source files plus a metadata.json manifest.`,
          })}
        >
          <svg class="rab-n-svg" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 2.5v7.5M5 7.2L8 10.2l3-3M2.8 12.8h10.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {zipping ? 'Zipping…' : zipFlash === 'done' ? 'Saved' : zipFlash === 'failed' ? 'Failed' : 'ZIP'}
        </button>
        <button
          type="button"
          class="rab-n-modal-hbtn"
          data-testid="source-dialog-undo"
          disabled={!lastUndo}
          onClick={onUndo}
          {...tipProps(lastUndo
            ? { title: 'Undo close', body: `Reopen ${lastUndo.label}.`, shortcut: 'Ctrl+Shift+T' }
            : { title: 'Undo close', body: 'No recently closed tabs to restore.' })}
        >
          Undo
        </button>
        <button
          type="button"
          class="rab-n-modal-hbtn"
          data-testid="source-dialog-close-all"
          disabled={tabs.length === 0}
          onClick={onCloseAll}
          {...tipProps({ title: 'Close all tabs', body: 'Close every open class tab (can be restored with Undo).' })}
        >
          Close all
        </button>
        <span class="rab-n-modal-hsep" aria-hidden="true" />
        <MaximizeButton
          on={maximized}
          onToggle={onToggleMaximize}
          what="decompiler window"
          testId="source-dialog-maximize"
          shortcut=""
          tip={maximized
            ? { title: 'Restore decompiler window', body: 'Return the decompiler window to its floating size (Esc minimizes).' }
            : { title: 'Maximize decompiler window', body: 'Expand the decompiler window to fill the viewport.' }}
        />
        <button
          type="button"
          class="rab-n-tool rab-n-modal-close"
          aria-label="Hide dialog (keeps open tabs)"
          data-testid="source-dialog-close"
          onClick={onMinimize}
          {...tipProps({ title: 'Hide window', body: 'Minimize the decompiler window while keeping all open tabs in the top bar\'s Classes button.', shortcut: 'Esc' })}
        >
          —
        </button>
      </div>
    </div>
  );
}

export function SourceDialogQuickOpen({
  inputRef,
  value,
  onChange,
  onSubmit,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (e: Event) => void;
}) {
  return (
    <form class="rab-n-modal-quickopen" onSubmit={onSubmit} data-testid="source-dialog-quickopen">
      <input
        ref={inputRef}
        type="text"
        class="rab-n-input"
        placeholder="Fully qualified class name or Class:line (e.g. java.lang.String or com.atlassian.jira.issue.Issue:42)"
        value={value}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        aria-label="Java class name to decompile"
      />
      <button type="submit" class="rab-n-button" disabled={!value.trim()}>Decompile</button>
    </form>
  );
}

export function SourceDialogEmpty({
  value,
  lastUndo,
  onChange,
  onSubmit,
  onUndo,
}: {
  value: string;
  lastUndo: ClosedSnapshot | undefined;
  onChange: (value: string) => void;
  onSubmit: (e: Event) => void;
  onUndo: () => void;
}) {
  return (
    <div class="rab-n-modal-empty" data-testid="source-dialog-empty">
      <p class="rab-n-subtle">No open class tabs. Click any Java type in the browser, or enter a class name below.</p>
      <form class="rab-n-modal-empty-form" onSubmit={onSubmit}>
        <input
          type="text"
          class="rab-n-input"
          placeholder="e.g. com.atlassian.jira.rest.v2.serverinfo.ServerInfoResource"
          value={value}
          onInput={(e) => onChange((e.target as HTMLInputElement).value)}
          aria-label="Java class name to decompile"
        />
        <button type="submit" class="rab-n-button" disabled={!value.trim()}>Decompile</button>
        {lastUndo && (
          <button type="button" class="rab-n-button" onClick={onUndo}>
            Undo close ({lastUndo.label})
          </button>
        )}
      </form>
    </div>
  );
}
