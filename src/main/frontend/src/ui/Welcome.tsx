import { moduleReason } from '../core/explain';
import type { Module, Summary } from '../core/types';
import { plural } from './bits';

export function Welcome({ summary, missing, indexing, linkWaiting, linkStarting, linkFailure, onStart }: {
  summary: Summary | null; missing: boolean; indexing: boolean; linkWaiting?: Module; linkStarting: boolean;
  linkFailure?: string; onStart: (m: Module) => void;
}) {
  let ops = 0, failed = 0, waiting = 0;
  for (const m of summary?.modules ?? []) {
    ops += m.opCount;
    const kind = moduleReason(m)?.kind;
    if (kind === 'failed') failed++;
    else if (kind === 'waiting') waiting++;
  }
  return (
    <div class="rab-n-welcome" data-testid="welcome">
      <div class="rab-n-welcome-inner">
        {missing && <div class="rab-n-banner">The operation in the link no longer exists on this instance.</div>}
        {linkWaiting && (
          <div class="rab-n-banner" data-testid="link-waiting">
            The operation in the link is in <strong>{linkWaiting.path}</strong>, which has not started yet on this node; it opens
            once the module is read.{' '}
            <button class="rab-n-link" onClick={() => !linkStarting && onStart(linkWaiting)}
                    aria-disabled={linkStarting || undefined} aria-busy={linkStarting || undefined}>
              {linkStarting ? 'Starting…' : linkFailure ? 'Try again' : 'Start it'}
            </button>
            {linkFailure && !linkStarting && <div class="rab-n-subtle">The last start: {linkFailure}.</div>}
          </div>
        )}
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
          <p class="rab-n-subtle rab-n-welcome-note">
            {plural(waiting, 'module')} {waiting === 1 ? 'has' : 'have'} not started yet on this node; select one in the list to
            start it (its hover card says more).
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
