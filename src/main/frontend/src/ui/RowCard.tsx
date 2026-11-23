import { useLayoutEffect } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { Module, Operation } from '../core/types';
import { MethodBadge, PathText, PinHint } from './bits';
import { accessFact, isSkipped, moduleFact, originLabel, paramSummary, sourceLabel, stabilityLabel, type Fact } from './facts';

export type CardTarget = { kind: 'op'; op: Operation; module?: Module } | { kind: 'module'; module: Module; count: number };

/**
 * The hover card of a list row: everything the row's ticks stand for, spelled out, with the app's full name and
 * what else helps to pick an operation. It sits beside the list, aligned with the row, and never takes the pointer.
 */
export function RowCard({ id, target, left, top, rowHeight, pinned, boxRef }: {
  id?: string; target: CardTarget; left: number; top: number; rowHeight: number; pinned: boolean;
  boxRef: { current: HTMLDivElement | null };
}) {
  const ref = boxRef;
  // keep the card inside the app: it moves up when it would overflow the bottom and left when it would overflow
  // the right (a wide list), over the list then, without its arrow; the arrow stays at the row, within the card
  useLayoutEffect(() => {
    const el = ref.current;
    const root = el?.offsetParent as HTMLElement | null;
    if (!el || !root) return;
    // taller than the app: its content scrolls inside (the card keeps 6 px from each edge, plus its own padding)
    const body = el.firstElementChild as HTMLElement | null;
    if (body) body.style.maxHeight = Math.max(80, root.clientHeight - 12 - (el.offsetHeight - body.offsetHeight)) + 'px';
    const y = Math.max(6, Math.min(top - 8, root.clientHeight - el.offsetHeight - 6));
    const x = Math.max(6, Math.min(left, root.clientWidth - el.offsetWidth - 6));
    el.style.top = y + 'px';
    el.style.left = x + 'px';
    el.classList.toggle('no-arrow', x < left);
    el.style.setProperty('--arrow', Math.round(Math.min(Math.max(top - y + rowHeight / 2, 12), el.offsetHeight - 12)) + 'px');
  });
  return (
    <div ref={ref} id={id} class={'rab-n-card' + (pinned ? ' pinned' : '')} role="tooltip" data-testid="row-card"
         style={{ left: left + 'px', top: top + 'px' }}>
      {/* the content scrolls when the card is taller than the app; the card itself keeps its arrow and accent */}
      <div class="rab-n-card-body">
        {target.kind === 'op' ? <OpFacts op={target.op} m={target.module} /> : <ModuleFacts m={target.module} count={target.count} />}
        <PinHint pinned={pinned} />
      </div>
    </div>
  );
}

function OpFacts({ op, m }: { op: Operation; m?: Module }) {
  const access = accessFact(op.access);
  return (
    <>
      <div class="rab-n-card-head">
        <MethodBadge method={op.method} />
        <span class="rab-n-card-path"><PathText path={(m ? m.path + '/' : '') + op.path} prefix={m?.path.length} /></span>
      </div>
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

function ModuleFacts({ m, count }: { m: Module; count: number }) {
  const source = sourceLabel(m.source);
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
            : m.state === 'pending' ? 'Being read…' : isSkipped(m) ? 'Not described (left out on purpose)' : 'Could not be described'}
        </Row>
        {m.state === 'failed' && (
          <Row name="Reason">
            <span class={isSkipped(m) ? 'rab-n-card-note' : 'rab-n-card-error'}>{m.reason ?? 'error'}{m.error ? ': ' + clip(m.error, 300) : ''}</span>
          </Row>
        )}
        {source && <Row name="Read from">{source}</Row>}
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
