import { formatIsoTime } from '../../core/detailserror';
import { statusTone } from '../../core/explain';
import type { Draft } from '../../core/operationform';
import { mediaChoices } from '../../core/request';
import type { Operation } from '../../core/types';
import { tipProps, type UiTipSpec } from '../../core/uitips';
import type { HistoryEntry } from '../userstore';

export function FormTools({ canUndo, canRedo, canReset, onUndo, onRedo, onReset }: {
  canUndo: boolean; canRedo: boolean; canReset: boolean; onUndo: () => void; onRedo: () => void; onReset: () => void;
}) {
  const icon = (d: string) => (
    <svg class="rab-n-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  return (
    <div class="rab-n-form-tools" role="group" aria-label="The form's changes">
      <button class="rab-n-tool" onClick={onUndo} disabled={!canUndo}
              aria-label="Undo" data-testid="form-undo"
              {...tipProps({ title: 'Undo form change', body: 'Revert the last edit to parameters, body, or headers (outside text inputs).', shortcut: 'Ctrl+Z' })}>
        {icon('M6 3.5L3 6.5l3 3M3.5 6.5h6a3.5 3.5 0 010 7H7')}
      </button>
      <button class="rab-n-tool" onClick={onRedo} disabled={!canRedo}
              aria-label="Redo" data-testid="form-redo"
              {...tipProps({ title: 'Redo form change', body: 'Reapply the last undone form edit (also Ctrl+Shift+Z).', shortcut: 'Ctrl+Y' })}>
        {icon('M10 3.5l3 3-3 3M12.5 6.5h-6a3.5 3.5 0 000 7H9')}
      </button>
      <button class="rab-n-tool" onClick={onReset} disabled={!canReset}
              aria-label="Reset the form" data-testid="form-reset"
              {...tipProps({ title: 'Reset form', body: 'Clear all edited fields back to this operation\'s defaults (can be undone).' })}>
        {icon('M3.2 8a4.8 4.8 0 104.8-4.8H5.6M7.2 1.6L5.4 3.2 7.2 4.8')}
      </button>
    </div>
  );
}

export function HeadersTab({ op, draft, onDraft, write }: { op: Operation; draft: Draft; onDraft: (d: Draft) => void; write: boolean }) {
  const produces = mediaChoices(op.produces);
  const custom = draft.custom.length ? draft.custom : [{ name: '', value: '' }];
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
        <label class="rab-n-row" {...tipProps({ title: 'XSRF protection header', body: 'Atlassian products reject write requests without X-Atlassian-Token: no-check. Uncheck it to test XSRF rejection.' })}>
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
          {draft.custom.length > 0 ? (
            <button class="rab-n-icon" aria-label={`Remove header ${i + 1}`}
                    {...tipProps({ title: 'Remove header', body: 'Delete this custom HTTP header from the request.' })}
                    onClick={() => setCustom(custom.filter((_, j) => j !== i))}>×</button>
          ) : <span class="rab-n-icon-slot" aria-hidden="true" />}
        </div>
      ))}
      <button class="rab-n-link" onClick={() => setCustom([...custom, { name: '', value: '' }])}
              {...tipProps({ title: 'Add custom header', body: 'Append an extra HTTP request header name/value pair.' })}>+ header</button>
    </div>
  );
}

export function HistoryTab({ entries, onRestore, onClear }: { entries: HistoryEntry[]; onRestore: (e: HistoryEntry) => void; onClear: () => void }) {
  if (!entries.length) {
    return <div class="rab-n-subtle rab-n-pad">No requests yet. With no documentation in the WADLs, the request that worked last time is the best example; it will be listed here.</div>;
  }
  return (
    <div class="rab-n-history" data-testid="history">
      {entries.map((e) => (
        <button key={e.id} class="rab-n-history-row" onClick={() => onRestore(e)} {...tipProps(historyTip(e))}>
          <span class={'rab-n-status-code ' + statusTone(e.status)}>{e.status ?? '?'}</span>
          <span class="rab-n-subtle rab-n-history-time">{formatIsoTime(e.at)}</span>
          <span class="rab-n-ellipsis rab-n-history-url">{e.url}</span>
          {(e.bodyTruncated || e.redacted) && (
            <span class="rab-n-history-note" data-testid="history-note">
              {[e.bodyTruncated && 'body cut', e.redacted && 'secrets left out'].filter(Boolean).join(', ')}
            </span>
          )}
        </button>
      ))}
      <button class="rab-n-link" onClick={onClear}
              {...tipProps({ title: 'Clear history', body: 'Delete saved local request history for this operation from your browser.', tone: 'warn' })}>
        Clear history
      </button>
    </div>
  );
}

function historyTip(e: HistoryEntry): UiTipSpec {
  const notes = [
    e.bodyTruncated && 'body was cut at 10,000 characters when saved',
    e.redacted && 'values that looked like secrets were omitted',
  ].filter(Boolean);
  return {
    title: 'Restore saved request',
    body: 'Refill parameters, body, and headers from this past request (does not send automatically).',
    note: notes.length ? notes.join('; ') : undefined,
  };
}
