import { useEffect, useRef, useState } from 'preact/hooks';
import { accessFact } from '../../core/facts';
import { fetchModuleOpenApi, moduleOpenApiFilename } from '../../core/openapi';
import { toCurl, type BuiltRequest, type UrlPart } from '../../core/request';
import type { Module, Operation } from '../../core/types';
import { tipProps, type UiTipSpec } from '../../core/uitips';
import type { Draft } from '../../core/operationform';
import type { OpenTabRequest } from '../../core/sourcetabs';
import { CopyButton, download, formatBytes, MethodBadge, PathText, useFlash, WRITE_METHODS } from '../bits';
import { AppLozenge } from '../java/AppLozenge';
import { JavaTypeExpr } from '../java/JavaTypeLinks';

function accessTip(access: string): UiTipSpec {
  const fact = accessFact(access);
  if (!fact) return { title: `Access: ${access}`, body: 'Security access annotation declared on this REST handler.' };
  const warn = fact.tone === 'admin' || fact.tone === 'sysadmin';
  return {
    title: `Access: ${fact.label}`,
    body: fact.detail ? `${fact.detail}.` : 'Security access annotation declared on this REST handler.',
    tone: warn ? 'warn' : undefined,
  };
}

function OpDoc({ summary, description }: { summary?: string; description?: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = !!description && (description.length > 220 || description.split('\n').length > 2);
  return (
    <div class="rab-n-op-doc" data-testid="operation-doc">
      {summary && <div class="rab-n-op-summary" data-testid="operation-summary">{summary}</div>}
      {description && (
        <>
          <div class={'rab-n-op-desc' + (long && !expanded ? ' is-clamped' : '')} data-testid="operation-description">{description}</div>
          {long && (
            <button type="button" class="rab-n-link rab-n-op-desc-toggle" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function UrlText({ parts }: { parts: UrlPart[] }) {
  return (
    <>
      {parts.map((p, i) => (p.kind === 'text' ? p.text : <span key={i} class={'rab-n-pp-' + p.kind}>{p.text}</span>))}
    </>
  );
}

export function OperationHeader({
  baseUrl, sysadmin, op, module, draft, built, running, compact, max, onSend, onCancel, onViewMaxResponse, onOpenClass,
}: {
  baseUrl: string;
  sysadmin?: boolean;
  op: Operation;
  module?: Module;
  draft: Draft;
  built: { request?: BuiltRequest; url: string; parts: UrlPart[]; error?: string };
  running: boolean;
  compact: boolean;
  max: 'top' | 'bottom' | null;
  onSend: () => void;
  onCancel: () => void;
  onViewMaxResponse: () => void;
  onOpenClass?: (req: OpenTabRequest) => void;
}) {
  const method = op.method.toUpperCase();
  const write = WRITE_METHODS.has(method);
  const isDelete = method === 'DELETE';
  const fullPath = (module ? module.path + '/' : '') + op.path;
  const isApp = module?.stability === 'app' || module?.origin === 'user';
  const hasBadges = module?.stability === 'supported' || isApp || !!op.access || !!op.deprecated;
  const absolute = (url: string) => (url.startsWith('/') ? location.origin + url : url);

  const [exportingApi, setExportingApi] = useState(false);
  const [apiState, setApiState] = useState<'idle' | 'done' | 'failed'>('idle');
  const flashApi = useFlash<'done' | 'failed'>(setApiState);
  const mountedRef = useRef(true);
  const modIdRef = useRef(module?.id);
  modIdRef.current = module?.id;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const exportModuleOpenApi = async () => {
    if (!module || module.state !== 'ok' || exportingApi) return;
    const mod = module;
    setExportingApi(true);
    try {
      const json = await fetchModuleOpenApi(baseUrl, mod.id);
      if (!mountedRef.current || modIdRef.current !== mod.id) return;
      download(new Blob([json], { type: 'application/json;charset=utf-8' }), moduleOpenApiFilename(mod));
      flashApi('done');
    } catch {
      if (mountedRef.current && modIdRef.current === mod.id) flashApi('failed');
    } finally {
      if (mountedRef.current) setExportingApi(false);
    }
  };

  return (
    <div class="rab-n-op-head">
      <div class="rab-n-op-title">
        <MethodBadge method={method} showTip />
        <span class="rab-n-op-fullpath" data-testid="operation-path"><PathText path={fullPath} prefix={module?.path.length} /></span>
        {hasBadges && (
          <span class="rab-n-op-badges">
            {module?.stability === 'supported' && (
              <span class="rab-n-tag rab-n-tag-supported" {...tipProps({ title: 'Supported public API', body: 'Part of the product\'s officially documented and supported REST API.' })}>
                Supported
              </span>
            )}
            {isApp && module && <AppLozenge baseUrl={baseUrl} module={module} sysadmin={sysadmin} />}
            {op.access && (
              <span class={'rab-n-tag rab-n-tag-access rab-n-tag-access-' + op.access.toLowerCase()} {...tipProps(accessTip(op.access))}>
                {op.access}
              </span>
            )}
            {op.deprecated && (
              <span class="rab-n-tag rab-n-tag-deprecated" {...tipProps({ title: 'Deprecated endpoint', body: 'Marked @Deprecated in the server code and may be removed in a future release.', tone: 'warn' })}>
                Deprecated
              </span>
            )}
          </span>
        )}
        <span class="rab-n-spacer" />
        <CopyButton
          label="Copy curl"
          testId="copy-curl"
          disabled={!built.request}
          tip={built.error
            ? { title: 'Copy as cURL', body: built.error, tone: 'warn' }
            : { title: 'Copy as cURL', body: 'Copy this request (method, URL, headers, and body) as a runnable curl command.' }}
          text={() => (built.request ? toCurl({ ...built.request, url: absolute(built.request.url) }) : '')}
        />
        {module && module.state === 'ok' && (
          <button
            type="button"
            class={'rab-n-button' + (apiState === 'done' ? ' copied' : apiState === 'failed' ? ' failed' : '')}
            data-testid="export-module-openapi"
            data-state={apiState}
            disabled={exportingApi}
            onClick={() => void exportModuleOpenApi()}
            {...tipProps({
              title: 'Export module OpenAPI 3.1',
              body: `Download an OpenAPI 3.1.0 JSON spec for module ${module.path}${sysadmin ? ' (including DTO schemas)' : ''}.`,
            })}
          >
            {exportingApi ? 'Exporting…' : apiState === 'done' ? 'Saved' : apiState === 'failed' ? 'Failed' : 'OpenAPI'}
          </button>
        )}
      </div>
      {(op.summary || op.description) && <OpDoc summary={op.summary} description={op.description} />}
      {(op.bodyType || op.returnType) && (
        <div class="rab-n-op-io" data-testid="operation-io-types">
          {op.bodyType && (
            <span class="rab-n-op-io-item" data-testid="operation-input-type">
              <span class="rab-n-subtle">Input</span>{' '}
              <code class="rab-n-op-io-code">
                <JavaTypeExpr typeExpr={op.bodyJavaType ?? op.bodyType} opKey={op.key} onOpenClass={onOpenClass} />
              </code>
            </span>
          )}
          {op.returnType && (
            <span class="rab-n-op-io-item" data-testid="operation-output-type">
              <span class="rab-n-subtle">Returns</span>{' '}
              <code class="rab-n-op-io-code">
                <JavaTypeExpr typeExpr={op.returnJavaType ?? op.returnType} opKey={op.key} onOpenClass={onOpenClass} />
              </code>
            </span>
          )}
        </div>
      )}
      <div class={'rab-n-urlbar' + (write ? ' is-write' : '') + (isDelete ? ' is-delete' : '')}>
        <div class="rab-n-url-group">
          <code class="rab-n-url" data-testid="live-url" title={built.url}><UrlText parts={built.parts} /></code>
          <CopyButton
            label="Copy URL"
            tip={{ title: 'Copy request URL', body: 'Copy the full resolved URL, including path and query parameters.' }}
            text={() => absolute(built.url)}
          />
        </div>
        {running ? (
          <button
            class="rab-n-button rab-n-cancel-btn"
            onClick={onCancel}
            {...tipProps({ title: 'Cancel request', body: 'Abort the currently running HTTP request.', shortcut: 'Esc' })}
          >
            Cancel
          </button>
        ) : (
          <button
            class={'rab-n-button rab-n-send' + (write ? ' write' : '') + (isDelete ? ' danger' : '')}
            onClick={onSend}
            disabled={!built.request}
            data-testid="send"
            {...tipProps(built.error
              ? { title: `Send ${method}`, body: built.error, tone: 'warn' }
              : isDelete
                ? { title: 'Send DELETE request', body: 'Execute this DELETE request against the live server using your current session.', note: 'May permanently remove data', shortcut: 'Ctrl+Enter', tone: 'danger' }
                : write
                  ? { title: `Send ${method} request`, body: `Execute this ${method} request against the live server using your current session.`, note: 'Changes server data', shortcut: 'Ctrl+Enter', tone: 'warn' }
                  : { title: `Send ${method} request`, body: 'Execute this read-only request from your browser using your current session.', shortcut: 'Ctrl+Enter' })}
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
        {max === 'top' && (running || draft.result) && (
          <button class="rab-n-max-status" data-testid="max-status" aria-live="polite"
                  {...tipProps({
                    title: 'View response',
                    body: compact || running ? 'Exit maximized mode and show request and response together.' : 'Switch to maximized response view.',
                  })}
                  onClick={onViewMaxResponse}>
            {running ? <><span class="rab-n-spinner" aria-hidden="true" /> Sending…</>
              : draft.result!.error ? (draft.result!.error === 'aborted' ? 'Cancelled' : 'Failed')
              : <>{draft.result!.status} · {Math.round(draft.result!.durationMs)} ms · {formatBytes(draft.result!.size)}</>}
          </button>
        )}
      </div>
    </div>
  );
}
