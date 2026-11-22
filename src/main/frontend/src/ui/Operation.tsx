import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Module, Operation, Param, Summary } from '../core/types';
import { buildRequest, mediaChoices, setHeader, toCurl, type BuiltRequest, type RequestValues } from '../core/request';
import { findTemplates } from '../core/template';
import type { RequestRunner, RunResult } from './runner';
import type { HistoryEntry, UserStore } from './userstore';
import { CopyButton, MethodBadge, Tabs, WRITE_METHODS } from './bits';
import { ResponseView } from './Response';

/** What the user has typed for one operation; kept per operation while the page is open. */
export interface Draft {
  values: RequestValues;
  custom: { name: string; value: string }[];
  noXsrfHeader: boolean;
  result: RunResult | null;
}

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

type Tab = 'params' | 'body' | 'headers' | 'history';

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

  useEffect(() => {
    setTab('params');
    userStore.history(op.key).then(
      (h) => mounted.current && setHistory(h),
      () => mounted.current && setHistory([]),
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
      const entry = await userStore.addHistory({
        opKey: op.key,
        method,
        url: request.url,
        values: sent.values,
        custom: sent.custom,
        noXsrfHeader: sent.noXsrfHeader,
        status: result.status,
        durationMs: Math.round(result.durationMs),
        size: result.size,
        bodyPreview: result.text?.slice(0, 2000),
      });
      if (mounted.current) setHistory((h) => [entry, ...h].slice(0, 20));
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
      } else if (e.key === 'Escape' && runner.running) {
        runner.abort();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [runner]);

  const setValues = (values: RequestValues) => setDraft({ ...latest.current, values });
  const visibleParams = withTemplateParams(op).filter((p) => p.in !== 'form');
  const formParams = op.params.filter((p) => p.in === 'form');
  const hasBadges = module?.stability === 'supported' || module?.stability === 'app' || !!op.access || !!op.deprecated;

  return (
    <div class="rab-n-operation" data-testid="operation">
      <div class="rab-n-op-head">
        <div class="rab-n-op-title">
          <MethodBadge method={method} />
          <span class="rab-n-op-fullpath" data-testid="operation-path">{fullPath}</span>
          <span class="rab-n-spacer" />
          <CopyButton label="Copy curl" testId="copy-curl" text={() => (built.request ? toCurl({ ...built.request, url: absolute(built.request.url) }) : '')} />
        </div>
        {hasBadges && (
          <div class="rab-n-op-badges">
            {module?.stability === 'supported' && <span class="rab-n-tag rab-n-tag-supported">Supported</span>}
            {module?.stability === 'app' && <span class="rab-n-tag rab-n-tag-app">App: {module.plugin.name}</span>}
            {op.access && <span class={'rab-n-tag rab-n-tag-access rab-n-tag-access-' + op.access.toLowerCase()} title="Access annotation of the handler">{op.access}</span>}
            {op.deprecated && <span class="rab-n-tag rab-n-tag-deprecated">Deprecated</span>}
          </div>
        )}
        <div class={'rab-n-urlbar' + (write ? ' is-write' : '') + (isDelete ? ' is-delete' : '')}>
          <div class="rab-n-url-group">
            <code class="rab-n-url" data-testid="live-url" title={built.url}>{built.url}</code>
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
        </div>
        {built.error && <div class="rab-n-hint" data-testid="build-error">{built.error}</div>}
      </div>
      <div class="rab-n-op-split">
        <div class="rab-n-request" style={{ flexBasis: Math.round(split * 100) + '%' }}>
          <Tabs<Tab>
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'params', label: `Params (${visibleParams.length})` },
              ...(hasBody ? [{ id: 'body' as Tab, label: 'Body' }] : []),
              { id: 'headers', label: 'Headers' },
              { id: 'history', label: `History (${history.length})` },
            ]}
          />
          <div class="rab-n-tabpane">
            {tab === 'params' && (
              <ParamsTab params={visibleParams} formParams={formParams} values={draft.values} onValues={setValues} />
            )}
            {tab === 'body' && <BodyTab op={op} values={draft.values} onValues={setValues} />}
            {tab === 'headers' && <HeadersTab op={op} draft={draft} onDraft={setDraft} write={write} />}
            {tab === 'history' && (
              <HistoryTab
                entries={history}
                onRestore={(e) =>
                  setDraft({ ...latest.current, values: e.values, custom: e.custom ?? [], noXsrfHeader: !!e.noXsrfHeader })
                }
                onClear={async () => {
                  await userStore.clearHistory(op.key);
                  if (mounted.current) setHistory([]);
                }}
              />
            )}
          </div>
        </div>
        <SplitHandle split={split} onSplit={onSplit} />
        <ResponseView result={draft.result} running={running} onCancel={cancel} />
      </div>
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

function tryBuild(summary: Summary, op: Operation, draft: Draft): { request?: BuiltRequest; url: string; error?: string } {
  try {
    const req = buildRequest(summary, op, draft.values, { accept: draft.values.accept, noXsrfHeader: draft.noXsrfHeader });
    for (const h of draft.custom) if (h.name.trim()) setHeader(req.headers, h.name.trim(), h.value);
    return { request: req, url: req.url };
  } catch (e) {
    // a required path parameter is still empty: show the template so the URL bar stays useful
    const module = summary.modules.find((m) => m.id === op.module);
    const url = `${summary.baseUrl}/rest/${module ? module.path + '/' : ''}${op.path}`;
    return { url, error: e instanceof Error ? e.message : String(e) };
  }
}

function ParamsTab({ params, formParams, values, onValues }: {
  params: Param[]; formParams: Param[]; values: RequestValues; onValues: (v: RequestValues) => void;
}) {
  if (!params.length && !formParams.length) return <div class="rab-n-subtle rab-n-pad">This operation takes no parameters.</div>;
  const order = ['path', 'query', 'header', 'matrix'];
  const sorted = [...params].sort((a, b) => order.indexOf(a.in) - order.indexOf(b.in) || Number(b.required) - Number(a.required));
  const set = (p: Param, list: string[]) => {
    if (p.in === 'query') onValues({ ...values, query: { ...values.query, [p.name]: list } });
    else onValues({ ...values, [p.in]: { ...(values as any)[p.in], [p.name]: list[0] ?? '' } });
  };
  const get = (p: Param): string[] =>
    p.in === 'query' ? values.query[p.name] ?? [''] : [((values as any)[p.in]?.[p.name] as string | undefined) ?? ''];
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
                {list.map((v, i) => (
                  <div class="rab-n-param-row" key={i}>
                    <ParamInput param={p} value={v} onChange={(nv) => set(p, list.map((x, j) => (j === i ? nv : x)))} />
                    {p.repeating && list.length > 1 && (
                      <button class="rab-n-icon" aria-label="Remove value" onClick={() => set(p, list.filter((_, j) => j !== i))}>×</button>
                    )}
                  </div>
                ))}
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

function ParamInput({ param, value, onChange }: { param: Param; value: string; onChange: (v: string) => void }) {
  const placeholder = param.default !== undefined ? 'default: ' + param.default : param.required ? 'required' : '';
  const on = (e: Event) => onChange((e.target as HTMLInputElement | HTMLSelectElement).value);
  if (param.type === 'boolean' || (param.options && param.options.length)) {
    const options = param.type === 'boolean' ? ['true', 'false'] : param.options!;
    return (
      <select class="rab-n-input" value={value} onChange={on} name={param.name}>
        <option value="">{placeholder || '(not set)'}</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  const numeric = param.type === 'int' || param.type === 'long' || param.type === 'number';
  return (
    <input
      class="rab-n-input"
      name={param.name}
      inputMode={numeric ? 'numeric' : undefined}
      value={value}
      placeholder={placeholder}
      onInput={on}
    />
  );
}

function BodyTab({ op, values, onValues }: { op: Operation; values: RequestValues; onValues: (v: RequestValues) => void }) {
  const types = mediaChoices(op.consumes);
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
    try {
      onValues({ ...values, body: JSON.stringify(JSON.parse(values.body ?? ''), null, 2) });
    } catch {
      // the error is already shown
    }
  };
  return (
    <div class="rab-n-body">
      <div class="rab-n-body-bar">
        <label>
          Content-Type{' '}
          <select class="rab-n-input" value={contentType} onChange={(e) => onValues({ ...values, contentType: (e.target as HTMLSelectElement).value })}>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        {op.bodyType && <span class="rab-n-subtle">Java type: {op.bodyType}</span>}
        <span class="rab-n-spacer" />
        {isJson && <button class="rab-n-button" onClick={format} disabled={!!error || !values.body?.trim()}>Format</button>}
      </div>
      <textarea
        class={'rab-n-textarea' + (error ? ' invalid' : '')}
        spellcheck={false}
        value={values.body ?? ''}
        onInput={(e) => onValues({ ...values, body: (e.target as HTMLTextAreaElement).value })}
        placeholder={isJson ? '{ }' : ''}
        data-testid="body"
      />
      {error && <div class="rab-n-error">JSON: {error}</div>}
    </div>
  );
}

function HeadersTab({ op, draft, onDraft, write }: { op: Operation; draft: Draft; onDraft: (d: Draft) => void; write: boolean }) {
  const produces = mediaChoices(op.produces);
  const custom = draft.custom.length ? draft.custom : [{ name: '', value: '' }];
  const setCustom = (list: { name: string; value: string }[]) => onDraft({ ...draft, custom: list });
  return (
    <div class="rab-n-pad">
      <label class="rab-n-row">
        Accept{' '}
        <select class="rab-n-input" value={draft.values.accept ?? produces[0]} onChange={(e) => onDraft({ ...draft, values: { ...draft.values, accept: (e.target as HTMLSelectElement).value } })}>
          {produces.map((t) => <option key={t} value={t}>{t}</option>)}
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
          <input class="rab-n-input" placeholder="Header" value={h.name} onInput={(e) => setCustom(custom.map((x, j) => (j === i ? { ...x, name: (e.target as HTMLInputElement).value } : x)))} />
          <input class="rab-n-input" placeholder="Value" value={h.value} onInput={(e) => setCustom(custom.map((x, j) => (j === i ? { ...x, value: (e.target as HTMLInputElement).value } : x)))} />
          <button class="rab-n-icon" aria-label="Remove header" onClick={() => setCustom(custom.filter((_, j) => j !== i))}>×</button>
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
        <button key={e.id} class="rab-n-history-row" onClick={() => onRestore(e)} title="Restore these values">
          <span class={'rab-n-status-code ' + statusClass(e.status)}>{e.status ?? '?'}</span>
          <span class="rab-n-subtle rab-n-history-time">{new Date(e.at).toLocaleString()}</span>
          <span class="rab-n-ellipsis rab-n-history-url">{e.url}</span>
        </button>
      ))}
      <button class="rab-n-link" onClick={onClear}>Clear history</button>
    </div>
  );
}

function SplitHandle({ split, onSplit }: { split: number; onSplit: (ratio: number) => void }) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    onSplit(Math.min(0.8, Math.max(0.15, split + (e.key === 'ArrowDown' ? 0.05 : -0.05))));
  };
  const ref = useRef<HTMLDivElement>(null);
  const onDown = (e: PointerEvent) => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    e.preventDefault();
    const rect = parent.getBoundingClientRect();
    const request = parent.firstElementChild as HTMLElement | null;
    let ratio = 0;
    // resize the element directly while dragging; the state (and a saved preference) follows once, on release
    const move = (ev: PointerEvent) => {
      ratio = Math.min(0.8, Math.max(0.15, (ev.clientY - rect.top) / rect.height));
      if (request) request.style.flexBasis = Math.round(ratio * 100) + '%';
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      if (ratio) onSplit(ratio);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  };
  return (
    <div ref={ref} class="rab-n-hsplit" onPointerDown={onDown} onKeyDown={onKeyDown} tabIndex={0}
         role="separator" aria-orientation="horizontal" aria-label="Resize the request and the response"
         aria-valuenow={Math.round(split * 100)} />
  );
}
