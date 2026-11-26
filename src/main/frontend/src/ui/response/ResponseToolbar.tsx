import { useEffect, useRef, useState } from 'preact/hooks';
import { statusInfo } from '../../core/explain';
import { downloadOf, textOf, type ResponseViewKind } from '../../core/responsetext';
import { tipProps } from '../../core/uitips';
import { copyText, download, plural, useFlash } from '../bits';
import { fetchEcho, type RunResult } from '../runner';

/** The rich tooltip of the response's status code. */
export function StatusTip({ status, statusText }: { status: number; statusText: string }) {
  const info = statusInfo(status, statusText);
  return (
    <>
      {(status > 0 || info.title) && <><span class="rab-n-tip-title">{[status || '', info.title].filter(Boolean).join(' ')}</span>{' '}</>}
      <span class="rab-n-tip-text">{info.text}</span>
    </>
  );
}

/** Copies what the open tab shows as text; safe against unmount or switching operations mid-echo fetch. */
export function CopyContentButton({ view, result, baseUrl, formatted }: {
  view: ResponseViewKind; result: RunResult; baseUrl: string; formatted: boolean;
}) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const flash = useFlash<'done' | 'failed'>(setState);
  const mounted = useRef(true);
  const current = useRef({ view, result });
  current.current = { view, result };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const body = view === 'pretty' || view === 'raw';
  const off = body && (result.size === 0 || result.kind === 'binary');
  const what = view === 'headers' ? 'the response\'s headers' : view === 'sent' ? 'the request\'s headers'
    : formatted ? 'the body, formatted' : 'the body';
  const label = off ? (result.kind === 'binary' ? 'A binary body cannot be copied: download it' : 'Nothing to copy: the body is empty')
    : state === 'done' ? 'Copied' : state === 'failed' ? 'The browser did not allow copying' : 'Copy ' + what;
  return (
    <button class={'rab-n-tool' + (state === 'done' ? ' done' : state === 'failed' ? ' failed' : '')} disabled={off} aria-label={label}
            data-testid="copy-content" data-state={state}
            {...tipProps({ title: 'Copy content', body: label, tone: off ? 'warn' : undefined })}
            onClick={async () => {
              const text = await textOf(view, result, baseUrl, fetchEcho);
              if (!mounted.current || current.current.view !== view || current.current.result !== result) return;
              flash(text !== null && (await copyText(text)) ? 'done' : 'failed');
            }}>
      {state === 'done' ? (
        <svg class="rab-n-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.2 8.4l3 3 6.6-6.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : state === 'failed' ? (
        <svg class="rab-n-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2.4l6 10.6H2L8 2.4z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M8 6.6v2.9M8 11.4v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      ) : (
        <svg class="rab-n-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10.5 5.5V4a1.5 1.5 0 00-1.5-1.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      )}
    </button>
  );
}

/** Downloads what the open tab shows; safe against unmount or switching operations mid-echo fetch. */
export function DownloadButton({ view, result, baseUrl, formatted }: {
  view: ResponseViewKind; result: RunResult; baseUrl: string; formatted: boolean;
}) {
  const empty = (view === 'pretty' || view === 'raw') && result.size === 0;
  const mounted = useRef(true);
  const current = useRef({ view, result });
  current.current = { view, result };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const what = view === 'headers' ? 'the response\'s headers' : view === 'sent' ? 'the request\'s headers'
    : formatted ? 'the body, formatted' : 'the body as received';
  const label = empty ? 'Nothing to download: the body is empty' : 'Download ' + what;
  return (
    <button class="rab-n-tool" disabled={empty} aria-label={label} data-testid="download"
            {...tipProps({ title: 'Download', body: label, tone: empty ? 'warn' : undefined })}
            onClick={async () => {
              const file = await downloadOf(view, result, baseUrl, fetchEcho);
              if (mounted.current && file && current.current.view === view && current.current.result === result) {
                download(file.blob, file.name);
              }
            }}>
      <svg class="rab-n-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 2.5v7.5M5 7.5L8 10.5l3-3M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/** Find as you type, 150 ms after the last key; Enter and Shift+Enter step through matches. */
export function FindBox({
  initial, reportedNeedle, onFind, onStep, count, index, unit,
  placeholder = 'Find in response', ariaLabel, inputRef, testId,
}: {
  initial: string; reportedNeedle: string; onFind: (needle: string) => void; onStep: (step: number) => void;
  count: number; index: number; unit: 'line' | 'row';
  placeholder?: string; ariaLabel?: string; inputRef?: { current: HTMLInputElement | null }; testId?: string;
}) {
  const [needle, setNeedle] = useState(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const pending = needle !== reportedNeedle;
  return (
    <div class="rab-n-find" data-testid={testId}>
      <div class="rab-n-find-wrap">
        <svg class="rab-n-svg rab-n-find-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5L13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          ref={(el) => { if (inputRef) inputRef.current = el; }}
          type="search"
          placeholder={placeholder}
          value={needle}
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            setNeedle(v);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              timer.current = undefined;
              onFind(v);
            }, 150);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && needle) {
              e.preventDefault();
              e.stopPropagation();
              clearTimeout(timer.current);
              timer.current = undefined;
              setNeedle('');
              onFind('');
              return;
            }
            if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey) return;
            e.preventDefault();
            if (timer.current !== undefined) {
              clearTimeout(timer.current);
              timer.current = undefined;
              onFind(needle);
            } else {
              onStep(e.shiftKey ? -1 : 1);
            }
          }}
          aria-label={ariaLabel ?? placeholder}
        />
      </div>
      {needle && (
        <span class="rab-n-subtle rab-n-find-count" data-testid="find-count" aria-live="polite">
          {pending ? '…' : count ? `${index + 1} of ${plural(count, unit)}` : 'no match'}
        </span>
      )}
    </div>
  );
}
