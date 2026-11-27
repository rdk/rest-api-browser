import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { DecompilerId } from '../core/details';
import { changedField, NO_HISTORY, record, redo as redoStep, undo as undoStep, type FormHistory, type FormState } from '../core/formhistory';
import {
  countFormWarnings, emptyDraft, templateRegexes, tryBuild, withTemplateParams, type Draft,
} from '../core/operationform';
import { hasActiveFormValues, type RequestValues } from '../core/request';
import type { OpenTabRequest } from '../core/sourcetabs';
import type { Module, Operation, Summary } from '../core/types';
import { tipProps } from '../core/uitips';
import { acquireInert, ESCAPE_PRIORITY, isInsideInert, SplitHandle, useEscape } from '../lib/overlay';
import { MaximizeButton, Tabs, tabId, WarnGlyph, WRITE_METHODS } from './bits';
import { JavaTab, type JavaPage } from './JavaTab';
import { BodyTab } from './operation/BodyTab';
import { FormTools, HeadersTab, HistoryTab } from './operation/HeadersHistoryTabs';
import { OperationHeader } from './operation/OperationHeader';
import { ParamsTab } from './operation/ParamsTab';
import { ResponseView } from './Response';
import type { RequestRunner } from './runner';
import { historyUrl, type HistoryEntry, type UserStore } from './userstore';

export { emptyDraft, type Draft };

export type RequestTab = 'params' | 'body' | 'headers' | 'history' | 'java';
type Tab = RequestTab;

interface Props {
  summary: Summary;
  op: Operation;
  module?: Module;
  initialDraft?: Draft;
  getInitialDraft?: (op: Operation) => Draft;
  onDraft: (key: string, d: Draft) => void;
  runner: RequestRunner;
  userStore: UserStore;
  split: number;
  onSplit: (ratio: number) => void;
  onOpenClass?: (req: OpenTabRequest) => void;
  decompiler?: DecompilerId;
  onDecompiler?: (d: DecompilerId) => void;
  prettySource?: boolean;
  onTogglePrettySource?: () => void;
  javaPage?: JavaPage;
  onJavaPage?: (p: JavaPage) => void;
  tab?: RequestTab;
  onTab?: (t: RequestTab) => void;
}

const formOf = (d: FormState): FormState => ({ values: d.values, custom: d.custom, noXsrfHeader: d.noXsrfHeader });

export function OperationView({
  summary, op, module, initialDraft, getInitialDraft, onDraft, runner, userStore, split, onSplit, onOpenClass,
  decompiler, onDecompiler, prettySource, onTogglePrettySource, javaPage, onJavaPage,
  tab: controlledTab, onTab,
}: Props) {
  const [localTab, setLocalTab] = useState<Tab>('params');
  const requestedTab = controlledTab ?? localTab;
  const setTab = (next: Tab) => {
    setLocalTab(next);
    onTab?.(next);
  };
  const [max, setMax] = useState<'top' | 'bottom' | null>(null);
  const maxRef = useRef(max);
  maxRef.current = max;
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [draft, setDraftState] = useState<Draft>(() => initialDraft ?? getInitialDraft?.(op) ?? emptyDraft(op));
  const [liveSplit, setLiveSplit] = useState<number | null>(null);
  const effectiveSplit = liveSplit ?? split;

  const latest = useRef(draft);
  latest.current = draft;
  const mounted = useRef(true);
  const setDraft = (d: Draft) => {
    latest.current = d;
    if (mounted.current) setDraftState(d);
    onDraft(op.key, d);
  };
  const runSeq = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setLiveSplit(null);
  }, [split]);

  const method = op.method.toUpperCase();
  const write = WRITE_METHODS.has(method);
  const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const tab: Tab = (requestedTab === 'body' && !hasBody) || (requestedTab === 'java' && !summary.sysadmin)
    ? 'params'
    : requestedTab;

  const historyGen = useRef(0);
  useEffect(() => {
    const gen = ++historyGen.current;
    userStore.history(op.key).then(
      (h) => mounted.current && gen === historyGen.current && setHistory(h),
      () => mounted.current && gen === historyGen.current && setHistory([]),
    );
  }, [op.key, userStore]);

  const built = useMemo(() => tryBuild(summary, op, draft), [summary, op, draft]);
  const rootRef = useRef<HTMLDivElement>(null);
  const splitBoxRef = useRef<HTMLDivElement>(null);

  const send = async () => {
    const sent = latest.current;
    const request = tryBuild(summary, op, sent).request;
    if (!request || runner.running) return;
    const run = ++runSeq.current;
    setRunning(true);
    const result = await runner.run(request);
    if (run !== runSeq.current || !mounted.current) return;
    setRunning(false);
    setDraft({ ...latest.current, result });
    if (!result.error) {
      const gen = ++historyGen.current;
      try {
        const entry = await userStore.addHistory({
          opKey: op.key,
          method,
          url: historyUrl(summary, op, sent.values),
          values: sent.values,
          custom: sent.custom,
          noXsrfHeader: sent.noXsrfHeader,
          status: result.status,
          durationMs: Math.round(result.durationMs),
          size: result.size,
        });
        if (mounted.current && gen === historyGen.current) setHistory((h) => [entry, ...h].slice(0, 20));
      } catch {
        // Storage quota/privacy rejection does not block running the request.
      }
    }
  };
  const cancel = () => runner.abort();
  const sendRef = useRef(send);
  sendRef.current = send;

  // LIFO Escape: abort running request first, then restore maximized request/response pane.
  useEscape(running || max !== null, () => {
    if (isInsideInert(rootRef.current)) return false;
    const t = document.activeElement as HTMLInputElement | null;
    if (t?.tagName === 'INPUT' && t.type === 'search' && t.value) return false;
    if (runner.running) {
      runner.abort();
      return true;
    }
    if (maxRef.current) {
      setMax(null);
      return true;
    }
    return false;
  }, ESCAPE_PRIORITY.BASE);

  // Ctrl+Enter sends the active operation unless covered by a modal/maximized inert layer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isInsideInert(rootRef.current)) return;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        sendRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [runner]);

  const editForm = (next: FormState, separate = false) => {
    const cur = latest.current;
    const historySteps: FormHistory | null = record(cur.history ?? NO_HISTORY, formOf(cur), next, Date.now(), separate);
    if (historySteps) setDraft({ ...cur, ...next, history: historySteps });
  };
  const step = (which: 'undo' | 'redo') => {
    const cur = latest.current;
    const done = (which === 'undo' ? undoStep : redoStep)(cur.history ?? NO_HISTORY, formOf(cur));
    if (done) setDraft({ ...cur, ...done.state, history: done.history });
  };
  const empty = useMemo(() => formOf(emptyDraft(op)), [op]);
  const resetForm = () => editForm(empty, true);
  const canUndo = !!draft.history?.undo.length;
  const canRedo = !!draft.history?.redo.length;
  const canReset = changedField(formOf(draft), empty) !== null;
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isInsideInert(rootRef.current) || !(e.ctrlKey || e.metaKey) || e.altKey || maxRef.current === 'bottom') return;
      const t = e.target as HTMLInputElement | null;
      const text = t && (t.tagName === 'TEXTAREA' || t.isContentEditable
        || (t.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(t.type)));
      if (text) return;
      const k = e.key.toLowerCase();
      if (k === 'z' || k === 'y') {
        e.preventDefault();
        stepRef.current(k === 'y' || e.shiftKey ? 'redo' : 'undo');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const setValues = (values: RequestValues, separate = false) => editForm({ ...formOf(latest.current), values }, separate);
  const visibleParams = useMemo(() => withTemplateParams(op), [op]);
  const hasForm = op.params.some((p) => p.in === 'form');
  const formActive = hasActiveFormValues(op, draft.values);
  const regexes = useMemo(() => templateRegexes(op.path), [op.path]);
  const warnings = useMemo(
    () => countFormWarnings(visibleParams, draft.values, regexes),
    [visibleParams, draft.values, regexes],
  );
  const compact = !draft.result || !!draft.result.error;

  useEffect(() => {
    if (compact && max === 'bottom') setMax(null);
  }, [compact, max]);

  useEffect(() => {
    if (!max) return;
    const app = rootRef.current?.closest('.rab-n');
    const covered = app ? [...app.querySelectorAll<HTMLElement>(':scope > .rab-n-topbar, :scope > .rab-n-body-row > :not(.rab-n-main)')] : [];
    return acquireInert(covered);
  }, [max]);

  const focusRestore = useRef(false);
  useEffect(() => {
    if (max !== 'bottom' || !focusRestore.current) return;
    focusRestore.current = false;
    (rootRef.current?.querySelector('[data-testid=max-bottom]') as HTMLElement | null)?.focus();
  }, [max]);

  return (
    <div ref={rootRef} class={'rab-n-operation' + (max ? ' max-' + max : '')} data-testid="operation">
      <OperationHeader
        baseUrl={summary.baseUrl}
        sysadmin={summary.sysadmin}
        op={op}
        module={module}
        draft={draft}
        built={built}
        running={running}
        compact={compact}
        max={max}
        onSend={send}
        onCancel={cancel}
        onViewMaxResponse={() => {
          if (compact || running) setMax(null);
          else {
            focusRestore.current = true;
            setMax('bottom');
          }
        }}
        onOpenClass={onOpenClass}
      />
      <div ref={splitBoxRef} class={'rab-n-op-split' + (compact ? ' is-compact' : '')}>
        <div class="rab-n-request" style={{ flexBasis: Math.round(effectiveSplit * 100) + '%' }}>
          <div class="rab-n-tabbar">
            <Tabs<Tab>
              value={tab}
              onChange={setTab}
              label="The request"
              panelId="rab-n-request-pane"
              tabs={[
                {
                  id: 'params',
                  tip: { title: 'Parameters', body: 'Path, query, form, header, and matrix parameters accepted by this operation.' },
                  label: (
                    <>
                      Params ({visibleParams.length})
                      {warnings > 0 && (
                        <span class="rab-n-tab-warn" data-testid="params-warn" {...tipProps({
                          title: 'Validation warning',
                          body: warnings === 1 ? '1 parameter value needs attention before sending.' : `${warnings} parameter values need attention before sending.`,
                          tone: 'warn',
                        })}>
                          <WarnGlyph size={12} />
                        </span>
                      )}
                    </>
                  ),
                },
                ...(hasBody ? [{ id: 'body' as Tab, label: 'Body', tip: { title: 'Request body', body: 'Edit the raw payload and Content-Type sent with this write request.' } }] : []),
                { id: 'headers', label: 'Headers', tip: { title: 'Request headers', body: 'Configure Accept header, XSRF protection header, and custom HTTP headers.' } },
                ...(summary.sysadmin ? [{ id: 'java' as Tab, label: 'Java', tip: { title: 'Java implementation', body: 'Inspect handler method, annotations, class hierarchy, OSGi bundle, plugin, and decompiled source.' } }] : []),
                { id: 'history', label: 'History', tip: { title: 'Request history', body: 'Recent requests sent to this endpoint from your browser so you can restore their inputs.' } },
              ]}
            />
            <FormTools canUndo={canUndo} canRedo={canRedo} canReset={canReset}
                       onUndo={() => step('undo')} onRedo={() => step('redo')} onReset={resetForm} />
            <span class="rab-n-tool-sep" aria-hidden="true" />
            <MaximizeButton on={max === 'top'} onToggle={() => setMax(max === 'top' ? null : 'top')} what="request" testId="max-top" />
          </div>
          <div class={'rab-n-tabpane' + (tab === 'java' ? ' is-java' : '')} id="rab-n-request-pane" role="tabpanel"
               aria-labelledby={tabId('rab-n-request-pane', tab)}>
            {tab === 'params' && (
              <ParamsTab params={visibleParams} values={draft.values} onValues={setValues} regexes={regexes} opKey={op.key} onOpenClass={onOpenClass} />
            )}
            {tab === 'body' && (
              <BodyTab
                baseUrl={summary.baseUrl}
                sysadmin={summary.sysadmin}
                op={op}
                values={draft.values}
                onValues={setValues}
                hasForm={hasForm}
                formActive={formActive}
                onOpenParams={() => setTab('params')}
                onOpenClass={onOpenClass}
              />
            )}
            {tab === 'java' && (
              <JavaTab
                baseUrl={summary.baseUrl}
                opKey={op.key}
                revision={summary.hash}
                decompiler={decompiler ?? 'vineflower'}
                onDecompiler={onDecompiler ?? (() => undefined)}
                pretty={prettySource}
                onPretty={onTogglePrettySource}
                onOpenClass={onOpenClass}
                page={javaPage}
                onPage={onJavaPage}
              />
            )}
            {tab === 'headers' && <HeadersTab op={op} draft={draft} onDraft={(d) => editForm(formOf(d))} write={write} />}
            {tab === 'history' && (
              <HistoryTab
                entries={history}
                onRestore={(e) => editForm({ values: e.values, custom: e.custom ?? [], noXsrfHeader: !!e.noXsrfHeader }, true)}
                onClear={async () => {
                  const gen = ++historyGen.current;
                  try {
                    await userStore.clearHistory(op.key);
                  } catch {
                    // Nothing kept to clear
                  }
                  if (mounted.current && gen === historyGen.current) setHistory([]);
                }}
              />
            )}
          </div>
        </div>
        {!compact && (
          <SplitHandle
            className="rab-n-hsplit"
            orientation="horizontal"
            label="Resize the request and the response"
            value={Math.round(effectiveSplit * 100)}
            min={15}
            max={80}
            step={5}
            bigStep={15}
            ariaValueText={`The request takes ${Math.round(effectiveSplit * 100)}%`}
            valuePerPixel={() => {
              const h = splitBoxRef.current?.clientHeight ?? 0;
              return h > 0 ? 100 / h : 0;
            }}
            onChange={(pct) => setLiveSplit(pct / 100)}
            onCommit={(pct) => {
              setLiveSplit(null);
              onSplit(pct / 100);
            }}
          />
        )}
        <ResponseView result={draft.result} running={running} onCancel={cancel} baseUrl={summary.baseUrl}
                      maximized={max === 'bottom'} onMaximize={() => setMax(max === 'bottom' ? null : 'bottom')} />
      </div>
    </div>
  );
}
