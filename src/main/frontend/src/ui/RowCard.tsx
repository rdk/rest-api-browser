import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { Module, Operation } from '../core/types';
import { download, MethodBadge, PathText, PinHint, useFlash } from './bits';
import { accessFact, moduleFact, originLabel, paramSummary, sourceLabel, stabilityLabel, type Fact } from '../core/facts';
import { fetchModuleOpenApi, moduleOpenApiFilename } from '../core/openapi';
import { cardLabel, moduleReason } from '../core/explain';

export type CardTarget = { kind: 'op'; op: Operation; module?: Module } | { kind: 'module'; module: Module; count: number };

/**
 * The hover card of a list row: everything the row's ticks stand for, spelled out, with the app's full name and
 * what else helps to pick an operation. It sits beside the list, aligned with the row, and never takes the pointer.
 */
export function RowCard({ id, target, left, top, rowHeight, pinned, boxRef, startFailure, baseUrl }: {
  id?: string; target: CardTarget; left: number; top: number; rowHeight: number; pinned: boolean;
  boxRef: { current: HTMLDivElement | null }; startFailure?: string; baseUrl?: string;
}) {
  const ref = boxRef;
  useLayoutEffect(() => {
    const el = ref.current;
    const root = el?.offsetParent as HTMLElement | null;
    if (!el || !root) return;
    // Batch DOM reads before style writes to avoid layout thrashing.
    const rootH = root.clientHeight;
    const rootW = root.clientWidth;
    const body = el.firstElementChild as HTMLElement | null;
    const extraH = body ? el.offsetHeight - body.offsetHeight : 0;
    const maxBodyH = Math.max(80, rootH - 12 - extraH);
    const elW = el.offsetWidth;
    const elH = Math.min(el.offsetHeight, rootH - 12);
    const y = Math.max(6, Math.min(top - 8, rootH - elH - 6));
    const x = Math.max(6, Math.min(left, rootW - elW - 6));
    const arrow = Math.round(Math.min(Math.max(top - y + rowHeight / 2, 12), Math.max(12, elH - 12)));

    if (body) body.style.maxHeight = maxBodyH + 'px';
    el.style.top = y + 'px';
    el.style.left = x + 'px';
    el.classList.toggle('no-arrow', x < left);
    el.style.setProperty('--arrow', arrow + 'px');
  }, [target, left, top, rowHeight, pinned, startFailure]);
  return (
    <div ref={ref} id={id} class={'rab-n-card' + (pinned ? ' pinned' : '')} role="tooltip" data-testid="row-card"
         style={{ left: left + 'px', top: top + 'px' }}>
      <div class="rab-n-card-body">
        {target.kind === 'op' ? <OpFacts op={target.op} m={target.module} /> : <ModuleFacts m={target.module} count={target.count} startFailure={startFailure} baseUrl={baseUrl} pinned={pinned} />}
        <PinHint pinned={pinned} />
      </div>
    </div>
  );
}

function cardSummary(op: Operation): string | undefined {
  if (op.summary) return op.summary;
  if (!op.description) return undefined;
  const line = op.description.split(/\r?\n/).find((l) => l.trim());
  return line ? clip(line.trim(), 160) : undefined;
}

function OpFacts({ op, m }: { op: Operation; m?: Module }) {
  const access = accessFact(op.access);
  const summary = cardSummary(op);
  return (
    <>
      <div class="rab-n-card-head">
        <MethodBadge method={op.method} />
        <span class="rab-n-card-path"><PathText path={(m ? m.path + '/' : '') + op.path} prefix={m?.path.length} /></span>
      </div>
      {summary && <div class="rab-n-card-summary" data-testid="card-summary">{summary}</div>}
      <dl class="rab-n-card-facts">
        {m && <Row name="API"><Dot fact={moduleFact(m)} />{stabilityLabel(m)}</Row>}
        <Row name="Access">
          {access ? <><Dot fact={access} />{access.label}{access.detail && <span class="rab-n-card-note"> · {access.detail}</span>}</> : 'Not annotated (the default applies)'}
        </Row>
        {op.deprecated && <Row name="Status"><Dot fact={{ tone: 'deprecated', label: '' }} />Deprecated</Row>}
        {m && <AppRows m={m} />}
        <Row name="Params">{op.params.length ? paramSummary(op) : 'None'}</Row>
        {op.bodyType && <Row name="Body"><span class="rab-n-card-mono">{op.bodyType}</span></Row>}
        {op.consumes.length > 0 && <Row name="Consumes"><span class="rab-n-card-mono">{op.consumes.join(', ')}</span></Row>}
        {op.produces.length > 0 && <Row name="Produces"><span class="rab-n-card-mono">{op.produces.join(', ')}</span></Row>}
      </dl>
    </>
  );
}

function ModuleFacts({ m, count, startFailure, baseUrl, pinned }: {
  m: Module; count: number; startFailure?: string; baseUrl?: string; pinned: boolean;
}) {
  const source = sourceLabel(m.source);
  const reason = moduleReason(m);
  const [exporting, setExporting] = useState(false);
  const [flashState, setFlashState] = useState<'idle' | 'done' | 'failed'>('idle');
  const flash = useFlash<'done' | 'failed'>(setFlashState);
  const mounted = useRef(true);
  const idRef = useRef(m.id);
  idRef.current = m.id;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const exportSpec = async () => {
    if (baseUrl === undefined || exporting) return;
    const mod = m;
    setExporting(true);
    try {
      const json = await fetchModuleOpenApi(baseUrl, mod.id);
      if (!mounted.current || idRef.current !== mod.id) return;
      download(new Blob([json], { type: 'application/json;charset=utf-8' }), moduleOpenApiFilename(mod));
      flash('done');
    } catch {
      if (mounted.current && idRef.current === mod.id) flash('failed');
    } finally {
      if (mounted.current) setExporting(false);
    }
  };
  return (
    <>
      <div class="rab-n-card-head">
        <span class="rab-n-card-path"><PathText path={m.path} rank={false} /></span>
      </div>
      <dl class="rab-n-card-facts">
        <Row name="API"><Dot fact={moduleFact(m)} />{stabilityLabel(m)}</Row>
        <AppRows m={m} />
        <Row name="Operations">
          {m.state === 'ok' ? (count === m.opCount ? m.opCount.toLocaleString() : `${count.toLocaleString()} of ${m.opCount.toLocaleString()} shown`)
            : reason ? cardLabel(reason) : 'Being read…'}
        </Row>
        {reason && (
          <Row name="Reason">
            <span class={reason.kind === 'failed' ? 'rab-n-card-error' : 'rab-n-card-strong'}>{reason.code}</span>
            <div class="rab-n-card-explain">{reason.text}</div>
            {startFailure && reason.kind === 'waiting' && <div class="rab-n-card-explain">The last start: {startFailure}.</div>}
            {m.error && <div class="rab-n-card-mono rab-n-card-note">{clip(m.error, 300)}</div>}
          </Row>
        )}
        {source && <Row name="Read from">{source}</Row>}
        {pinned && m.state === 'ok' && baseUrl !== undefined && (
          <Row name="OpenAPI 3.1">
            <button type="button" class="rab-n-link" data-testid="card-export-openapi" disabled={exporting} onClick={() => void exportSpec()}>
              {exporting ? 'Exporting…' : flashState === 'done' ? 'Downloaded OpenAPI JSON' : flashState === 'failed' ? 'Export failed' : 'Download specification'}
            </button>
          </Row>
        )}
      </dl>
    </>
  );
}

function AppRows({ m }: { m: Module }) {
  return (
    <>
      <Row name="App">
        {m.plugin.name}
        <div class="rab-n-card-mono rab-n-card-note">{m.plugin.key}{m.plugin.version ? ' ' + m.plugin.version : ''}</div>
      </Row>
      <Row name="From">{originLabel(m)}</Row>
      <Row name="Module"><span class="rab-n-card-mono rab-n-card-note">{m.id}</span></Row>
    </>
  );
}

function Row({ name, children }: { name: string; children: ComponentChildren }) {
  return (
    <>
      <dt>{name}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Dot({ fact }: { fact?: Fact }) {
  return fact ? <span class={'rab-n-tick rab-n-card-tick rab-n-tone-' + fact.tone} aria-hidden="true" /> : null;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
