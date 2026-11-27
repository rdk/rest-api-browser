import { useEffect, useRef, useState } from 'preact/hooks';
import { buildLines, formatJson } from '../../lib/json-lines';
import { fetchOperationSchema, shortJava } from '../../core/details';
import { describeDetailsError } from '../../core/detailserror';
import { mediaChoices, type RequestValues } from '../../core/request';
import type { OpenTabRequest } from '../../core/sourcetabs';
import type { Operation } from '../../core/types';
import { tipProps } from '../../core/uitips';
import { CheckMark } from '../bits';
import { JavaTypeExpr } from '../java/JavaTypeLinks';

const SYNC_JSON_LIMIT = 4096;
const AUTO_JSON_LIMIT = 150_000;

function parseJsonError(text: string): string | null {
  try {
    JSON.parse(text);
    return buildLines(text) ? null : 'Invalid JSON structure';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function BodyTab({ baseUrl = '', sysadmin = false, op, values, onValues, hasForm, formActive, onOpenParams, onOpenClass }: {
  baseUrl?: string; sysadmin?: boolean;
  op: Operation; values: RequestValues; onValues: (v: RequestValues, separate?: boolean) => void;
  hasForm: boolean; formActive: boolean; onOpenParams: () => void; onOpenClass?: (req: OpenTabRequest) => void;
}) {
  const types = mediaChoices(op.consumes);
  const [formatNote, setFormatNote] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const contentType = values.contentType ?? types[0];
  const isJson = /json/i.test(contentType);
  const body = values.body ?? '';
  const mountedRef = useRef(true);
  const preserveNoteRef = useRef(false);
  const latestRef = useRef({ opKey: op.key, values, onValues });
  latestRef.current = { opKey: op.key, values, onValues };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setFormatNote(null);
    setGenerating(false);
  }, [op.key]);

  useEffect(() => {
    if (preserveNoteRef.current) {
      preserveNoteRef.current = false;
      return;
    }
    setFormatNote(null);
  }, [body, contentType]);

  const [error, setError] = useState<string | null>(() =>
    isJson && body.trim() && body.length <= SYNC_JSON_LIMIT ? parseJsonError(body) : null);

  useEffect(() => {
    if (!isJson || !body.trim() || body.length > AUTO_JSON_LIMIT) {
      setError(null);
      return;
    }
    if (body.length <= SYNC_JSON_LIMIT) {
      setError(parseJsonError(body));
      return;
    }
    const timer = setTimeout(() => setError(parseJsonError(body)), 150);
    return () => clearTimeout(timer);
  }, [body, isJson]);

  const format = () => {
    const formatted = formatJson(body);
    setFormatNote(formatted === null ? 'Too large or too deeply nested to format' : null);
    if (formatted !== null && formatted !== body) onValues({ ...values, body: formatted }, true);
  };

  const generateExample = async () => {
    const reqKey = op.key;
    setGenerating(true);
    setFormatNote(null);
    try {
      const info = await fetchOperationSchema(baseUrl, reqKey);
      if (!mountedRef.current || latestRef.current.opKey !== reqKey) return;
      const ex = info.requestBody?.example;
      if (ex === undefined) {
        setFormatNote('No example payload available for this endpoint');
        return;
      }
      const nextBody = typeof ex === 'string' ? ex : JSON.stringify(ex, null, 2);
      const cur = latestRef.current.values;
      if (nextBody !== (cur.body ?? '')) {
        preserveNoteRef.current = true;
      }
      latestRef.current.onValues({ ...cur, body: nextBody }, true);
      const typeLabel = info.requestBody?.javaType ? shortJava(info.requestBody.javaType) : (op.bodyType ?? 'DTO');
      setFormatNote(`Generated example from ${typeLabel}`);
    } catch (e) {
      if (mountedRef.current && latestRef.current.opKey === reqKey) {
        setFormatNote(describeDetailsError(e, 'details'));
      }
    } finally {
      if (mountedRef.current && latestRef.current.opKey === reqKey) {
        setGenerating(false);
      }
    }
  };
  return (
    <div class="rab-n-body">
      {formActive && (
        <div class="rab-n-body-note" data-testid="form-body-note" role="status">
          The request body is built from the form parameters in Params.{' '}
          <button type="button" class="rab-n-link" onClick={onOpenParams}>Edit form fields</button>
        </div>
      )}
      {hasForm && !formActive && (
        <div class="rab-n-subtle rab-n-body-hint">
          Fill form parameters in <button type="button" class="rab-n-link" onClick={onOpenParams}>Params</button> to encode the body automatically, or enter a raw body below.
        </div>
      )}
      <div class="rab-n-body-bar">
        <label>
          Content-Type{' '}
          <select class="rab-n-input" value={contentType} onChange={(e) => onValues({ ...values, contentType: (e.target as HTMLSelectElement).value })}>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
            {!types.includes(contentType) && <option value={contentType}>{contentType}</option>}
          </select>
        </label>
        {op.bodyType && (
          <span class="rab-n-subtle" data-testid="body-java-type">
            Java type:{' '}
            <JavaTypeExpr typeExpr={op.bodyJavaType ?? op.bodyType} opKey={op.key} onOpenClass={onOpenClass} />
          </span>
        )}
        {formatNote && <span class="rab-n-subtle" role="status">{formatNote}</span>}
        <span class="rab-n-spacer" />
        {isJson && !!body.trim() && !formActive && body.length <= AUTO_JSON_LIMIT && (
          <span class={'rab-n-json-check ' + (error ? 'is-warn' : 'is-ok')} data-testid="json-check">
            <CheckMark check={error ? { state: 'warn', message: 'Not valid JSON: ' + error } : { state: 'ok', message: 'Valid JSON' }} />
            <span class="rab-n-json-check-text" title={error ?? undefined}>{error ? 'Not valid JSON: ' + error : 'Valid JSON'}</span>
          </span>
        )}
        {sysadmin && isJson && (op.bodyType || op.bodyJavaType) && (
          <button
            type="button"
            class="rab-n-button"
            data-testid="generate-example"
            onClick={() => void generateExample()}
            disabled={formActive || generating}
            {...tipProps({ title: 'Generate example JSON', body: 'Synthesize a representative JSON request body from the endpoint DTO Java type via /code/schema.' })}
          >
            {generating ? 'Generating…' : 'Generate example'}
          </button>
        )}
        {isJson && (
          <button
            class="rab-n-button"
            onClick={format}
            disabled={formActive || !!error || !body.trim()}
            {...tipProps({ title: 'Format JSON', body: 'Pretty-print the JSON request body with 2-space indentation.' })}
          >
            Format
          </button>
        )}
      </div>
      <textarea
        class={'rab-n-textarea' + (error && !formActive ? ' invalid' : '')}
        spellcheck={false}
        disabled={formActive}
        aria-invalid={error && !formActive ? 'true' : undefined}
        value={body}
        onInput={(e) => onValues({ ...values, body: (e.target as HTMLTextAreaElement).value })}
        placeholder={formActive ? 'Built from form parameters in the Params tab' : isJson ? '{ }' : ''}
        aria-label="Request body"
        data-testid="body"
      />
    </div>
  );
}
