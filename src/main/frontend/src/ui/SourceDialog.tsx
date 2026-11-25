import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  DetailsError, fetchSource, forgetSource,
  type DecompilerId, type OperationSource,
} from '../core/details';
import { tokenizeSource } from '../core/javatokens';
import { classLabel, linkSourceTokens } from '../core/javarefs';
import { CopyButton } from './bits';

export interface SourceTab {
  id: string;
  label: string;
  candidates: string[];
  fromBundle?: number;
  opKey?: string;
}

/** In-place segmented toggle between CFR and Vineflower. */
export function DecompilerToggle({ value, onChange }: { value: DecompilerId; onChange: (d: DecompilerId) => void }) {
  return (
    <span class="rab-n-seg" role="group" aria-label="Decompiler" data-testid="decompiler-toggle">
      <button
        type="button"
        class={'rab-n-seg-btn' + (value === 'cfr' ? ' on' : '')}
        aria-pressed={value === 'cfr'}
        data-testid="decompiler-cfr"
        onClick={() => onChange('cfr')}
      >
        CFR
      </button>
      <button
        type="button"
        class={'rab-n-seg-btn' + (value === 'vineflower' ? ' on' : '')}
        aria-pressed={value === 'vineflower'}
        data-testid="decompiler-vineflower"
        onClick={() => onChange('vineflower')}
      >
        Vineflower
      </button>
    </span>
  );
}

/** Decompiled Java code with syntax colouring and clickable class/annotation links. */
export function SourceCode({ source, className, refs, onOpenClass }: {
  source: string; className: string; refs?: string[]; onOpenClass: (target: string, candidates: string[]) => void;
}) {
  const spans = useMemo(
    () => linkSourceTokens(tokenizeSource(source), source, className, refs),
    [source, className, refs],
  );
  return (
    <>
      {spans.map((s, i) => {
        if (s.target) {
          return (
            <button
              key={i}
              type="button"
              class={'rab-n-jc-link rab-n-jc-' + s.kind}
              title={`Decompile ${s.target}`}
              data-class-ref={s.target}
              onClick={() => onOpenClass(s.target, s.candidates)}
            >
              {s.text}
            </button>
          );
        }
        if (s.kind === 'space' || s.kind === 'name') return s.text;
        return <span key={i} class={'rab-n-jc-' + s.kind}>{s.text}</span>;
      })}
    </>
  );
}

export function describeSourceError(e: unknown): string {
  if (e instanceof DetailsError) {
    if (e.status === 403 && e.reason === 'decompile-disabled') return 'Decompiling is disabled on this instance (-Drest.api.browser.decompile=false).';
    if (e.status === 403) return 'Only system administrators see decompiled source.';
    if (e.reason === 'class-not-found') return 'The bytecode of this class could not be found (it may be generated at runtime or not on the classpath).';
    if (e.reason === 'invalid-class') return 'Invalid class name.';
    if (e.reason === 'session-expired') return 'Your session has expired: reload the page to log in again.';
    if (e.reason === 'not-source') return 'The server answered with something other than the decompiled source.';
    return `The server could not decompile it (${e.reason}).`;
  }
  return 'The request failed: ' + (e instanceof Error ? e.message : String(e));
}

/**
 * Tabbed modal dialog for exploring decompiled Java classes. Clicking any class reference inside a tab opens (or
 * switches to) a tab for that class, and the decompiler toggle switches between CFR and Vineflower in place.
 */
export function SourceDialog({
  baseUrl, tabs, activeId, decompiler, onDecompiler, onSelectTab, onCloseTab, onOpenClass, onResolveTab, onClose,
}: {
  baseUrl: string;
  tabs: SourceTab[];
  activeId: string;
  decompiler: DecompilerId;
  onDecompiler: (d: DecompilerId) => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onOpenClass: (target: string, candidates: string[], fromBundle?: number) => void;
  onResolveTab: (tabId: string, resolvedClass: string) => void;
  onClose: () => void;
}) {
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Escape closes the dialog (capture phase so it runs before page handlers)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  // Make the app behind the dialog inert while open
  useEffect(() => {
    const app = dialogRef.current?.closest('.rab-n');
    const covered = app ? [...app.querySelectorAll<HTMLElement>(':scope > .rab-n-topbar, :scope > .rab-n-body-row')] : [];
    for (const el of covered) el.setAttribute('inert', '');
    return () => {
      for (const el of covered) el.removeAttribute('inert');
    };
  }, []);

  if (!active) return null;

  return (
    <div
      ref={dialogRef}
      class="rab-n-modal-backdrop"
      data-testid="source-dialog"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div class="rab-n-modal" role="dialog" aria-modal="true" aria-label="Decompiled Java classes">
        <div class="rab-n-modal-tabs" role="tablist" aria-label="Open Java classes">
          <div class="rab-n-modal-tabstrip">
            {tabs.map((t) => {
              const selected = t.id === active.id;
              return (
                <div key={t.id} class={'rab-n-modal-tab' + (selected ? ' on' : '')} data-testid="source-dialog-tab" data-class={t.id}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    class="rab-n-modal-tab-btn"
                    title={t.id}
                    onClick={() => onSelectTab(t.id)}
                  >
                    {t.label}
                  </button>
                  <button
                    type="button"
                    class="rab-n-modal-tab-close"
                    aria-label={`Close ${t.label}`}
                    title={`Close ${t.label}`}
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
            class="rab-n-tool rab-n-modal-close"
            aria-label="Close dialog"
            title="Close (Esc)"
            data-testid="source-dialog-close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <DialogTabPane
          key={active.id}
          baseUrl={baseUrl}
          tab={active}
          decompiler={decompiler}
          onDecompiler={onDecompiler}
          onOpenClass={onOpenClass}
          onResolveTab={onResolveTab}
        />
      </div>
    </div>
  );
}

function DialogTabPane({
  baseUrl, tab, decompiler, onDecompiler, onOpenClass, onResolveTab,
}: {
  baseUrl: string;
  tab: SourceTab;
  decompiler: DecompilerId;
  onDecompiler: (d: DecompilerId) => void;
  onOpenClass: (target: string, candidates: string[], fromBundle?: number) => void;
  onResolveTab: (tabId: string, resolvedClass: string) => void;
}) {
  const [src, setSrc] = useState<OperationSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const resolveRef = useRef(onResolveTab);
  resolveRef.current = onResolveTab;

  const query = useMemo(
    () => ({
      op: tab.opKey,
      classCandidates: tab.candidates,
      fromBundle: tab.fromBundle,
      scope: 'class' as const,
      decompiler,
    }),
    [tab.opKey, tab.candidates, tab.fromBundle, decompiler],
  );

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fetchSource(baseUrl, query).then(
      (s) => {
        if (!live) return;
        setSrc(s);
        setLoading(false);
        if (s.class && s.class !== tab.id) resolveRef.current(tab.id, s.class);
      },
      (e) => {
        if (!live) return;
        setError(describeSourceError(e));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [baseUrl, query, tab.id, attempt]);

  const retry = () => {
    forgetSource(query);
    setAttempt((a) => a + 1);
  };

  const fqcn = src?.class ?? tab.id;

  return (
    <>
      <div class="rab-n-modal-bar">
        <code class="rab-n-modal-fqcn" title={fqcn} data-testid="dialog-class-name">{fqcn}</code>
        {src && <span class="rab-n-subtle rab-n-modal-engine" data-testid="dialog-decompiler">{src.decompiler}</span>}
        <span class="rab-n-spacer" />
        <DecompilerToggle value={decompiler} onChange={onDecompiler} />
        <CopyButton quiet label="Copy class" text={() => fqcn} />
        {src && <CopyButton quiet label="Copy source" text={() => src.source} />}
      </div>
      <div class="rab-n-modal-body" role="tabpanel" aria-label={classLabel(fqcn)}>
        {loading ? (
          <div class="rab-n-pad rab-n-subtle" role="status" data-testid="dialog-loading">
            <span class="rab-n-spinner" aria-hidden="true" /> Decompiling {classLabel(fqcn)} with {decompiler === 'vineflower' ? 'Vineflower' : 'CFR'}…
          </div>
        ) : error ? (
          <div class="rab-n-pad rab-n-java-error" role="alert" data-testid="dialog-error">
            {error}{' '}
            <button type="button" class="rab-n-quiet" onClick={retry}>Try again</button>
          </div>
        ) : src ? (
          <pre class="rab-n-java-code rab-n-java-source-code rab-n-modal-code" data-testid="dialog-source-code">
            <SourceCode
              source={src.source}
              className={src.class}
              refs={src.refs}
              onOpenClass={(target, cands) => onOpenClass(target, cands, src.bundleId)}
            />
          </pre>
        ) : null}
      </div>
    </>
  );
}
