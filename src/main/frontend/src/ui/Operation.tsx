import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Module, Operation, Param, Summary } from '../core/types';
import { buildRequest, mediaChoices, setHeader, toCurl, urlParts, type BuiltRequest, type RequestValues, type UrlPart } from '../core/request';
import { findTemplates } from '../core/template';
import { checkValue, type Check } from '../core/validate';
import { changedField, NO_HISTORY, record, redo as redoStep, undo as undoStep, type FormHistory, type FormState } from '../core/formhistory';
import { formatJson } from '../core/jsonlines';
import type { RequestRunner, RunResult } from './runner';
import { historyUrl, type HistoryEntry, type UserStore } from './userstore';
import { CheckMark, CopyButton, MaximizeButton, MethodBadge, PathText, Tabs, WarnGlyph, WRITE_METHODS, formatBytes, tabId } from './bits';
import { ResponseView } from './Response';
import { JavaTab } from './JavaTab';

/** What the user has typed for one operation; kept per operation while the page is open. */
export interface Draft {
  values: RequestValues;
  custom: { name: string; value: string }[];
  noXsrfHeader: boolean;
  result: RunResult | null;
  /** The form's undo and redo steps. */
  history?: FormHistory;
}

const formOf = (d: FormState): FormState => ({ values: d.values, custom: d.custom, noXsrfHeader: d.noXsrfHeader });

export function emptyDraft(op: Operation): Draft {
  const query: Record<string, string[]> = {};
  for (const p of op.params) if (p.in === 'query') query[p.name] = [''];
  return {
    values: {
      path: {}, query, header: {}, matrix: {},
      contentType: mediaChoices(op.consumes)[0], accept: mediaChoices(op.produces)[0],
    },
    custom: [],
    noXsrfHeader: false,
    result: null,
  };
}

type Tab = 'params' | 'body' | 'headers' | 'history' | 'java';

interface Props {
  summary: Summary;
  op: Operation;
  module?: Module;
  /** The draft to start from; the view owns it from then on and reports every change through onDraft. */
  initialDraft: Draft;
  onDraft: (key: string, d: Draft) => void;
  runner: RequestRunner;
  userStore: UserStore;
  split: number;
  onSplit: (ratio: number) => void;
}

export function OperationView({ summary, op, module, initialDraft, onDraft, runner, userStore, split, onSplit }: Props) {
  const [tab, setTab] = useState<Tab>('params');
  // a box on the whole screen: the request (with its URL bar) or the response; Escape gives it back its place
  const [max, setMax] = useState<'top' | 'bottom' | null>(null);
  const maxRef = useRef(max);
  maxRef.current = max;
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  // the draft lives here, so typing re-renders this view only, not the list or the whole page
  const [draft, setDraftState] = useState<Draft>(initialDraft);
  const latest = useRef(draft);
  const mounted = useRef(true);
  const setDraft = (d: Draft) => {
    latest.current = d;
    if (mounted.current) setDraftState(d);
    onDraft(op.key, d);
  };
  // switching to another operation cancels the running request (App does it where the selection changes);
  // here only the bookkeeping: a closed view or a superseded run must not write its result
  const runSeq = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const method = op.method.toUpperCase();
  const write = WRITE_METHODS.has(method);
  const isDelete = method === 'DELETE';
  const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const fullPath = (module ? module.path + '/' : '') + op.path;

  // bumped by every change of the history here, so a first read that answers late does not overwrite it
  const historyGen = useRef(0);
  useEffect(() => {
    setTab('params');
    const gen = historyGen.current;
    userStore.history(op.key).then(
      (h) => mounted.current && gen === historyGen.current && setHistory(h),
      () => mounted.current && gen === historyGen.current && setHistory([]),
    );
  }, [op.key]);

  const built = useMemo(() => tryBuild(summary, op, draft), [summary, op, draft]);
  const absolute = (url: string) => (url.startsWith('/') ? location.origin + url : url);

  const send = async () => {
    const sent = latest.current;
    const request = tryBuild(summary, op, sent).request;
    if (!request || runner.running) return;
    const run = ++runSeq.current;
    setRunning(true);
    const result = await runner.run(request);
    if (run !== runSeq.current || !mounted.current) return; // a newer run took over, or the view closed
    setRunning(false);
    // keep what was typed while the request ran; only the result is new
    setDraft({ ...latest.current, result });
    if (!result.error) {
      historyGen.current++;
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
        if (mounted.current) setHistory((h) => [entry, ...h].slice(0, 20));
      } catch {
        // the browser's storage refused it (full, private mode): the request still ran, its history is just not kept
      }
    }
  };
  const cancel = () => runner.abort();
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        sendRef.current();
        return;
      }
      // (not e.defaultPrevented: the product's own page handlers cancel Escape on the whole document)
      if (e.key !== 'Escape') return;
      // Escape in a search box with text clears the box, nothing else
      const t = e.target as HTMLInputElement | null;
      if (t?.tagName === 'INPUT' && t.type === 'search' && t.value) return;
      // a running request first (the response says "Cancel (Esc)"), then the box on the whole screen
      if (runner.running) runner.abort();
      else if (maxRef.current) setMax(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [runner]);

  // every change of the form goes through here, so it can be undone; the response is not part of it
  const editForm = (next: FormState, separate = false) => {
    const cur = latest.current;
    const history = record(cur.history ?? NO_HISTORY, formOf(cur), next, Date.now(), separate);
    if (history) setDraft({ ...cur, ...next, history });
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
    // Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y outside a text field (a field keeps its own undo of what is typed into it)
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || maxRef.current === 'bottom') return;
      // a text field keeps its own undo; a select or a checkbox has none, so the form's applies there too
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
  // separate: a step of its own (a button such as Format), never merged with the typing just before
  const setValues = (values: RequestValues, separate = false) => editForm({ ...formOf(latest.current), values }, separate);
  const visibleParams = withTemplateParams(op).filter((p) => p.in !== 'form');
  const formParams = op.params.filter((p) => p.in === 'form');
  const regexes = useMemo(() => templateRegexes(op.path), [op.path]);
  const warnings = visibleParams.reduce(
    (n, p) => n + valuesOf(p, draft.values).filter((v, i, all) => checkAt(p, v, i, all, regexOf(p, regexes))?.state === 'warn').length, 0);
  // the response takes room only once there is one to show; until then a slim line, and the form has the space
  const compact = !draft.result || !!draft.result.error;
  // a response on the whole screen that turns into a slim line (a failed or cancelled re-send) gives the screen back:
  // the slim line has no button to do it
  useEffect(() => {
    if (compact && max === 'bottom') setMax(null);
  }, [compact, max]);
  // what a box on the whole screen covers (the header, the list) leaves the Tab order and the shortcuts
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!max) return;
    const app = rootRef.current?.closest('.rab-n');
    const covered = app ? [...app.querySelectorAll<HTMLElement>(':scope > .rab-n-topbar, :scope > .rab-n-body-row > :not(.rab-n-main)')] : [];
    for (const el of covered) el.setAttribute('inert', '');
    return () => {
      for (const el of covered) el.removeAttribute('inert');
    };
  }, [max]);
  // an app: by its stability, or installed by an admin (the list's tick says the same, facts.moduleFact)
  const isApp = module?.stability === 'app' || module?.origin === 'user';
  const hasBadges = module?.stability === 'supported' || isApp || !!op.access || !!op.deprecated;
  // the response's restore button gets the focus when the response takes the screen from the outcome beside Send
  const focusRestore = useRef(false);
  useEffect(() => {
    if (max !== 'bottom' || !focusRestore.current) return;
    focusRestore.current = false;
    (rootRef.current?.querySelector('[data-testid=max-bottom]') as HTMLElement | null)?.focus();
  }, [max]);

  return (
    <div ref={rootRef} class={'rab-n-operation' + (max ? ' max-' + max : '')} data-testid="operation">
      <div class="rab-n-op-head">
        <div class="rab-n-op-title">
          <MethodBadge method={method} />
          <span class="rab-n-op-fullpath" data-testid="operation-path"><PathText path={fullPath} prefix={module?.path.length} /></span>
          {hasBadges && (
            <span class="rab-n-op-badges">
              {module?.stability === 'supported' && <span class="rab-n-tag rab-n-tag-supported">Supported</span>}
              {isApp && module && <span class="rab-n-tag rab-n-tag-app">App: {module.plugin.name}</span>}
              {op.access && <span class={'rab-n-tag rab-n-tag-access rab-n-tag-access-' + op.access.toLowerCase()} title="Access annotation of the handler">{op.access}</span>}
              {op.deprecated && <span class="rab-n-tag rab-n-tag-deprecated">Deprecated</span>}
            </span>
          )}
          <span class="rab-n-spacer" />
          <CopyButton label="Copy curl" testId="copy-curl" disabled={!built.request} title={built.error ?? 'The request as a curl command'}
                      text={() => (built.request ? toCurl({ ...built.request, url: absolute(built.request.url) }) : '')} />
        </div>
        <div class={'rab-n-urlbar' + (write ? ' is-write' : '') + (isDelete ? ' is-delete' : '')}>
          <div class="rab-n-url-group">
            <code class="rab-n-url" data-testid="live-url" title={built.url}><UrlText parts={built.parts} /></code>
            <CopyButton label="Copy URL" text={() => absolute(built.url)} />
          </div>
          {running ? (
            <button class="rab-n-button rab-n-cancel-btn" onClick={cancel}>Cancel</button>
          ) : (
            <button
              class={'rab-n-button rab-n-send' + (write ? ' write' : '') + (isDelete ? ' danger' : '')}
              onClick={send}
              disabled={!built.request}
              title={built.error ?? (write ? `Changes data (${method}). Ctrl+Enter` : 'Ctrl+Enter')}
              data-testid="send"
            >
              {write ? (
                <svg class="rab-n-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 2.2L14.2 13H1.8L8 2.2z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                  <path d="M8 6.2v3.2M8 11.2v.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              ) : (
                <svg class="rab-n-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M2.5 8h10.5M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              Send {method}
            </button>
          )}
          {/* the response is hidden while the request has the whole screen: its outcome shows here */}
          {max === 'top' && (running || draft.result) && (
            <button class="rab-n-max-status" data-testid="max-status" aria-live="polite"
                    title={compact || running ? 'Show the request and the response again' : 'Show the response on the whole screen'}
                    onClick={() => {
                      if (compact || running) setMax(null);
                      else {
                        focusRestore.current = true;
                        setMax('bottom');
                      }
                    }}>
              {running ? <><span class="rab-n-spinner" aria-hidden="true" /> Sending…</>
                : draft.result!.error ? (draft.result!.error === 'aborted' ? 'Cancelled' : 'Failed')
                : <>{draft.result!.status} · {Math.round(draft.result!.durationMs)} ms · {formatBytes(draft.result!.size)}</>}
            </button>
          )}
        </div>
      </div>
      <div class={'rab-n-op-split' + (compact ? ' is-compact' : '')}>
        <div class="rab-n-request" style={{ flexBasis: Math.round(split * 100) + '%' }}>
          <div class="rab-n-tabbar">
          <Tabs<Tab>
            value={tab}
            onChange={setTab}
            label="The request"
            panelId="rab-n-request-pane"
            tabs={[
              {
                id: 'params',
                label: (
                  <>
                    Params ({visibleParams.length})
                    {warnings > 0 && (
                      <span class="rab-n-tab-warn" title={warnings === 1 ? '1 value needs attention' : `${warnings} values need attention`} data-testid="params-warn">
                        <WarnGlyph size={12} />
                      </span>
                    )}
                  </>
                ),
              },
              ...(hasBody ? [{ id: 'body' as Tab, label: 'Body' }] : []),
              { id: 'headers', label: 'Headers' },
              { id: 'history', label: `History (${history.length})` },
              // the Java behind the operation: internals, so for system administrators only (as the endpoint)
              ...(summary.sysadmin ? [{ id: 'java' as Tab, label: 'Java' }] : []),
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
              <ParamsTab params={visibleParams} formParams={formParams} values={draft.values} onValues={setValues} regexes={regexes} />
            )}
            {tab === 'body' && <BodyTab op={op} values={draft.values} onValues={setValues} />}
            {tab === 'java' && <JavaTab baseUrl={summary.baseUrl} opKey={op.key} revision={summary.hash} />}
            {tab === 'headers' && <HeadersTab op={op} draft={draft} onDraft={(d) => editForm(formOf(d))} write={write} />}
            {tab === 'history' && (
              <HistoryTab
                entries={history}
                onRestore={(e) => editForm({ values: e.values, custom: e.custom ?? [], noXsrfHeader: !!e.noXsrfHeader }, true)}
                onClear={async () => {
                  historyGen.current++;
                  try {
                    await userStore.clearHistory(op.key);
                  } catch {
                    // nothing kept to clear
                  }
                  if (mounted.current) setHistory([]);
                }}
              />
            )}
          </div>
        </div>
        {!compact && <SplitHandle split={split} onSplit={onSplit} />}
        <ResponseView result={draft.result} running={running} onCancel={cancel} baseUrl={summary.baseUrl}
                      maximized={max === 'bottom'} onMaximize={() => setMax(max === 'bottom' ? null : 'bottom')} />
      </div>
    </div>
  );
}

/** Undo, redo and reset of the form, at the end of the request's tab bar. */
function FormTools({ canUndo, canRedo, canReset, onUndo, onRedo, onReset }: {
  canUndo: boolean; canRedo: boolean; canReset: boolean; onUndo: () => void; onRedo: () => void; onReset: () => void;
}) {
  const icon = (d: string) => (
    <svg class="rab-n-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  return (
    <div class="rab-n-form-tools" role="group" aria-label="The form's changes">
      <button class="rab-n-tool" onClick={onUndo} disabled={!canUndo} title="Undo the last change of the form (Ctrl+Z outside a field)"
              aria-label="Undo" data-testid="form-undo">
        {icon('M6 3.5L3 6.5l3 3M3.5 6.5h6a3.5 3.5 0 010 7H7')}
      </button>
      <button class="rab-n-tool" onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y or Ctrl+Shift+Z outside a field)"
              aria-label="Redo" data-testid="form-redo">
        {icon('M10 3.5l3 3-3 3M12.5 6.5h-6a3.5 3.5 0 000 7H9')}
      </button>
      <button class="rab-n-tool" onClick={onReset} disabled={!canReset} title="Reset the form to its defaults (can be undone)"
              aria-label="Reset the form" data-testid="form-reset">
        {icon('M3.2 8a4.8 4.8 0 104.8-4.8H5.6M7.2 1.6L5.4 3.2 7.2 4.8')}
      </button>
    </div>
  );
}

/** The operation's parameters, plus a required path parameter for any template no parameter declares. */
function withTemplateParams(op: Operation): Param[] {
  const declared = new Set(op.params.filter((p) => p.in === 'path').map((p) => p.name));
  const missing = [...new Set(findTemplates(op.path).map((t) => t.name))]
    .filter((name) => !declared.has(name))
    .map((name): Param => ({ name, in: 'path', type: 'string', required: true }));
  return missing.length ? [...op.params, ...missing] : op.params;
}

/** The template's regex applies to the path parameter of that name only, not to a query or header one. */
const regexOf = (p: Param, regexes: Record<string, string>) => (p.in === 'path' && Object.hasOwn(regexes, p.name) ? regexes[p.name] : undefined);

/** The regex of each path template that has one: "{mode: view|edit}". */
function templateRegexes(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of findTemplates(path)) if (t.regex) out[t.name] = t.regex;
  return out;
}

/** A parameter's values as the form shows them: a query parameter's list (at least one field), else its one value. */
function valuesOf(p: Param, values: RequestValues): string[] {
  const map = (values as any)[p.in] as Record<string, unknown> | undefined;
  const v = map && Object.hasOwn(map, p.name) ? map[p.name] : undefined;
  if (p.in === 'query') return Array.isArray(v) && v.length ? (v as string[]) : [''];
  return [typeof v === 'string' ? v : ''];
}

/** The check of one of a parameter's values; an empty extra value of a repeating one is fine. */
function checkAt(p: Param, v: string, i: number, all: string[], regex?: string): Check {
  if (!v.trim() && (i > 0 || all.some((x) => x.trim()))) return null;
  return checkValue(p, v, regex);
}

/**
 * The live URL, rendered like the list's paths: the base and the module fainter, the first resource word bold, the
 * second bold in its own color, each value in the color of its kind of parameter (path, query, matrix), so a value
 * keeps the color its {template} had; a missing required value keeps its template, underlined.
 */
function UrlText({ parts }: { parts: UrlPart[] }) {
  return (
    <>
      {parts.map((p, i) => (p.kind === 'text' ? p.text : <span key={i} class={'rab-n-pp-' + p.kind}>{p.text}</span>))}
    </>
  );
}

function tryBuild(summary: Summary, op: Operation, draft: Draft): { request?: BuiltRequest; url: string; parts: UrlPart[]; error?: string } {
  // the parts also while a required path value is missing: its template shows, so the URL bar stays useful
  const { parts } = urlParts(summary, op, draft.values);
  const url = parts.map((p) => p.text).join('');
  try {
    const req = buildRequest(summary, op, draft.values, { accept: draft.values.accept, noXsrfHeader: draft.noXsrfHeader });
    for (const h of draft.custom) if (h.name.trim()) setHeader(req.headers, h.name.trim(), h.value);
    return { request: req, url: req.url, parts };
  } catch (e) {
    return { url, parts, error: e instanceof Error ? e.message : String(e) };
  }
}

function ParamsTab({ params, formParams, values, onValues, regexes }: {
  params: Param[]; formParams: Param[]; values: RequestValues; onValues: (v: RequestValues) => void; regexes: Record<string, string>;
}) {
  if (!params.length && !formParams.length) return <div class="rab-n-subtle rab-n-pad">This operation takes no parameters.</div>;
  const order = ['path', 'query', 'header', 'matrix'];
  const sorted = [...params].sort((a, b) => order.indexOf(a.in) - order.indexOf(b.in) || Number(b.required) - Number(a.required));
  const set = (p: Param, list: string[]) => {
    if (p.in === 'query') onValues({ ...values, query: { ...values.query, [p.name]: list } });
    else onValues({ ...values, [p.in]: { ...(values as any)[p.in], [p.name]: list[0] ?? '' } });
  };
  const get = (p: Param): string[] => valuesOf(p, values);
  return (
    <table class="rab-n-params" data-testid="params">
      <tbody>
        {sorted.map((p) => {
          const list = get(p);
          return (
            <tr key={p.in + ':' + p.name}>
              <td class="rab-n-param-name">
                {p.name}
                {p.required && <span class="rab-n-required" title="Required">*</span>}
              </td>
              <td class="rab-n-param-value">
                {list.map((v, i) => {
                  const check = checkAt(p, v, i, list, regexOf(p, regexes));
                  return (
                  <div class="rab-n-param-row" key={i}>
                    <ParamInput param={p} value={v} invalid={check?.state === 'warn' && !!v.trim()} onChange={(nv) => set(p, list.map((x, j) => (j === i ? nv : x)))} />
                    <CheckMark check={check} />
                    {p.repeating && list.length > 1 && (
                      <button class="rab-n-icon" aria-label={`Remove ${p.name} value ${i + 1}`} title="Remove this value"
                              onClick={() => set(p, list.filter((_, j) => j !== i))}>×</button>
                    )}
                  </div>
                  );
                })}
                {p.repeating && p.in === 'query' && (
                  <button class="rab-n-link" onClick={() => set(p, [...list, ''])}>+ value</button>
                )}
              </td>
              <td class="rab-n-param-meta">
                <span class={'rab-n-in rab-n-in-' + p.in}>{p.in}</span> {p.type}
              </td>
            </tr>
          );
        })}
        {formParams.map((p) => (
          <tr key={'form:' + p.name} class="rab-n-disabled">
            <td class="rab-n-param-name">{p.name}</td>
            <td class="rab-n-param-value rab-n-subtle">Form fields are not supported yet: send a body instead.</td>
            <td class="rab-n-param-meta"><span class="rab-n-in">form</span> {p.type}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const INTEGER_TYPES = new Set(['int', 'integer', 'long', 'short', 'byte', 'biginteger']);
const DECIMAL_TYPES = new Set(['number', 'double', 'float', 'bigdecimal']);

function ParamInput({ param, value, invalid, onChange }: { param: Param; value: string; invalid?: boolean; onChange: (v: string) => void }) {
  const cls = 'rab-n-input' + (invalid ? ' is-warn' : '');
  const type = param.type.toLowerCase();
  const placeholder = param.default && param.in !== 'path' ? 'default: ' + param.default : param.required ? 'required' : '';
  const on = (e: Event) => onChange((e.target as HTMLInputElement | HTMLSelectElement).value);
  const label = `${param.name} (${param.in} parameter${param.required ? ', required' : ''})`;
  if (type === 'boolean' || (param.options && param.options.length)) {
    const options = type === 'boolean' ? ['true', 'false'] : param.options!;
    return (
      <select class={cls} value={value} onChange={on} name={param.name} aria-label={label}>
        <option value="">{placeholder || '(not set)'}</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
        {/* a value from the history or a link that is not one of the choices still shows, as it is sent */}
        {value && !options.includes(value) && <option value={value}>{value}</option>}
      </select>
    );
  }
  return (
    <input
      class={cls}
      name={param.name}
      aria-label={label}
      inputMode={INTEGER_TYPES.has(type) ? 'numeric' : DECIMAL_TYPES.has(type) ? 'decimal' : undefined}
      value={value}
      placeholder={placeholder}
      onInput={on}
    />
  );
}

function BodyTab({ op, values, onValues }: { op: Operation; values: RequestValues; onValues: (v: RequestValues, separate?: boolean) => void }) {
  const types = mediaChoices(op.consumes);
  const [formatNote, setFormatNote] = useState<string | null>(null);
  const contentType = values.contentType ?? types[0];
  const isJson = /json/i.test(contentType);
  const error = useMemo(() => {
    if (!isJson || !values.body?.trim()) return null;
    try {
      JSON.parse(values.body);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [values.body, isJson]);
  const format = () => {
    const formatted = formatJson(values.body ?? '');
    // valid JSON that formatJson declines is too deep or too large to lay out
    setFormatNote(formatted === null ? 'Too large or too deeply nested to format' : null);
    if (formatted !== null && formatted !== values.body) onValues({ ...values, body: formatted }, true);
  };
  return (
    <div class="rab-n-body">
      <div class="rab-n-body-bar">
        <label>
          Content-Type{' '}
          <select class="rab-n-input" value={contentType} onChange={(e) => onValues({ ...values, contentType: (e.target as HTMLSelectElement).value })}>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
            {/* a type from the history that the operation no longer lists still shows, as it is sent */}
            {!types.includes(contentType) && <option value={contentType}>{contentType}</option>}
          </select>
        </label>
        {op.bodyType && <span class="rab-n-subtle">Java type: {op.bodyType}</span>}
        {formatNote && <span class="rab-n-subtle" role="status">{formatNote}</span>}
        <span class="rab-n-spacer" />
        {isJson && !!values.body?.trim() && (
          <span class={'rab-n-json-check ' + (error ? 'is-warn' : 'is-ok')} data-testid="json-check">
            <CheckMark check={error ? { state: 'warn', message: 'Not valid JSON: ' + error } : { state: 'ok', message: 'Valid JSON' }} />
            <span class="rab-n-json-check-text" title={error ?? undefined}>{error ? 'Not valid JSON: ' + error : 'Valid JSON'}</span>
          </span>
        )}
        {isJson && <button class="rab-n-button" onClick={format} disabled={!!error || !values.body?.trim()}>Format</button>}
      </div>
      <textarea
        class={'rab-n-textarea' + (error ? ' invalid' : '')}
        spellcheck={false}
        value={values.body ?? ''}
        onInput={(e) => onValues({ ...values, body: (e.target as HTMLTextAreaElement).value })}
        placeholder={isJson ? '{ }' : ''}
        aria-label="Request body"
        data-testid="body"
      />
    </div>
  );
}

function HeadersTab({ op, draft, onDraft, write }: { op: Operation; draft: Draft; onDraft: (d: Draft) => void; write: boolean }) {
  const produces = mediaChoices(op.produces);
  const custom = draft.custom.length ? draft.custom : [{ name: '', value: '' }];
  // one row left and empty is the same as none (the empty row shown then)
  const setCustom = (list: { name: string; value: string }[]) =>
    onDraft({ ...draft, custom: list.length === 1 && !list[0].name && !list[0].value ? [] : list });
  const accept = draft.values.accept ?? produces[0];
  return (
    <div class="rab-n-pad">
      <label class="rab-n-row">
        Accept{' '}
        <select class="rab-n-input" value={accept} onChange={(e) => onDraft({ ...draft, values: { ...draft.values, accept: (e.target as HTMLSelectElement).value } })}>
          {produces.map((t) => <option key={t} value={t}>{t}</option>)}
          {!produces.includes(accept) && <option value={accept}>{accept}</option>}
        </select>
      </label>
      {write && (
        <label class="rab-n-row" title="Atlassian products reject writes without it (XSRF protection); switch it off to test that">
          <input type="checkbox" checked={!draft.noXsrfHeader} onChange={(e) => onDraft({ ...draft, noXsrfHeader: !(e.target as HTMLInputElement).checked })} />{' '}
          X-Atlassian-Token: no-check <span class="rab-n-subtle">(sent automatically)</span>
        </label>
      )}
      <div class="rab-n-subtle rab-n-row rab-n-cookie-note">The browser sends your session cookie; Authorization headers are not needed.</div>
      {custom.map((h, i) => (
        <div class="rab-n-headers-custom-row" key={i}>
          <input class="rab-n-input" placeholder="Header" aria-label={`Header ${i + 1}: name`} value={h.name}
                 onInput={(e) => setCustom(custom.map((x, j) => (j === i ? { ...x, name: (e.target as HTMLInputElement).value } : x)))} />
          <input class="rab-n-input" placeholder="Value" aria-label={`Header ${i + 1}: value`} value={h.value}
                 onInput={(e) => setCustom(custom.map((x, j) => (j === i ? { ...x, value: (e.target as HTMLInputElement).value } : x)))} />
          {/* the empty row shown when there are none has nothing to remove */}
          {draft.custom.length > 0 ? (
            <button class="rab-n-icon" aria-label={`Remove header ${i + 1}`} title="Remove this header" onClick={() => setCustom(custom.filter((_, j) => j !== i))}>×</button>
          ) : <span class="rab-n-icon-slot" aria-hidden="true" />}
        </div>
      ))}
      <button class="rab-n-link" onClick={() => setCustom([...custom, { name: '', value: '' }])}>+ header</button>
    </div>
  );
}

function HistoryTab({ entries, onRestore, onClear }: { entries: HistoryEntry[]; onRestore: (e: HistoryEntry) => void; onClear: () => void }) {
  if (!entries.length) {
    return <div class="rab-n-subtle rab-n-pad">No requests yet. With no documentation in the WADLs, the request that worked last time is the best example; it will be listed here.</div>;
  }
  const statusClass = (s?: number) => (!s ? 'info' : s >= 500 ? 'err' : s >= 400 ? 'warn' : s >= 300 ? 'info' : 'ok');
  return (
    <div class="rab-n-history" data-testid="history">
      {entries.map((e) => (
        <button key={e.id} class="rab-n-history-row" onClick={() => onRestore(e)} title={historyTitle(e)}>
          <span class={'rab-n-status-code ' + statusClass(e.status)}>{e.status ?? '?'}</span>
          <span class="rab-n-subtle rab-n-history-time">{new Date(e.at).toLocaleString()}</span>
          <span class="rab-n-ellipsis rab-n-history-url">{e.url}</span>
          {(e.bodyTruncated || e.redacted) && (
            <span class="rab-n-history-note" data-testid="history-note">
              {[e.bodyTruncated && 'body cut', e.redacted && 'secrets left out'].filter(Boolean).join(', ')}
            </span>
          )}
        </button>
      ))}
      <button class="rab-n-link" onClick={onClear}>Clear history</button>
    </div>
  );
}

/** What restoring a history row gives back, with what it cannot give back. */
function historyTitle(e: HistoryEntry): string {
  const notes = [
    e.bodyTruncated && 'the body was cut at 10,000 characters when it was saved',
    e.redacted && 'values that looked like secrets were not saved',
  ].filter(Boolean);
  return 'Restore these values' + (notes.length ? ' (' + notes.join('; ') + ')' : '');
}

function SplitHandle({ split, onSplit }: { split: number; onSplit: (ratio: number) => void }) {
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    onSplit(Math.min(0.8, Math.max(0.15, split + (e.key === 'ArrowDown' ? 0.05 : -0.05))));
  };
  const ref = useRef<HTMLDivElement>(null);
  // a drag cut short (the response turned into a slim line, another operation opened) leaves no listener behind
  const stop = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stop.current?.(), []);
  const onDown = (e: PointerEvent) => {
    const parent = ref.current?.parentElement;
    const rect = parent?.getBoundingClientRect();
    if (!parent || !rect?.height || e.button !== 0) return;
    e.preventDefault();
    stop.current?.();
    const request = parent.firstElementChild as HTMLElement | null;
    let ratio = 0;
    // resize the element directly while dragging; the state (and a saved preference) follows once, on release
    const move = (ev: PointerEvent) => {
      ratio = Math.min(0.8, Math.max(0.15, (ev.clientY - rect.top) / rect.height));
      if (request) request.style.flexBasis = Math.round(ratio * 100) + '%';
    };
    const detach = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      stop.current = undefined;
    };
    const up = () => {
      detach();
      if (ratio) onSplit(ratio);
    };
    stop.current = detach;
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  };
  return (
    <div ref={ref} class="rab-n-hsplit" onPointerDown={onDown} onKeyDown={onKeyDown} tabIndex={0}
         role="separator" aria-orientation="horizontal" aria-label="Resize the request and the response"
         aria-valuenow={Math.round(split * 100)} aria-valuemin={15} aria-valuemax={80} aria-valuetext={`The request takes ${Math.round(split * 100)}%`} />
  );
}
