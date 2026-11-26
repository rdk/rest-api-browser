import { checkAt, regexOf, valuesOf } from '../../core/operationform';
import type { RequestValues } from '../../core/request';
import { fallbackJavaType } from '../../core/restoutline';
import type { OpenTabRequest } from '../../core/sourcetabs';
import type { Param } from '../../core/types';
import { tipProps } from '../../core/uitips';
import { CheckMark } from '../bits';
import { JavaTypeButton, JavaTypeExpr } from '../java/JavaTypeLinks';
import { FileParamField } from './FileParamField';

const INTEGER_TYPES = new Set(['int', 'integer', 'long', 'short', 'byte', 'biginteger']);
const DECIMAL_TYPES = new Set(['number', 'double', 'float', 'bigdecimal']);

export function ParamsTab({ params, values, onValues, regexes, opKey, onOpenClass }: {
  params: Param[]; values: RequestValues; onValues: (v: RequestValues, separate?: boolean) => void; regexes: Record<string, string>;
  opKey: string; onOpenClass?: (req: OpenTabRequest) => void;
}) {
  if (!params.length) return <div class="rab-n-subtle rab-n-pad">This operation takes no parameters.</div>;
  const order = ['path', 'query', 'form', 'header', 'matrix'];
  const sorted = [...params].sort((a, b) => order.indexOf(a.in) - order.indexOf(b.in) || Number(b.required) - Number(a.required));
  const set = (p: Param, list: string[]) => {
    if (p.in === 'query') onValues({ ...values, query: { ...values.query, [p.name]: list } });
    else if (p.in === 'form') onValues({ ...values, form: { ...(values.form ?? {}), [p.name]: list } });
    else onValues({ ...values, [p.in]: { ...(values as unknown as Record<string, unknown>)[p.in] as Record<string, string>, [p.name]: list[0] ?? '' } });
  };
  const setFiles = (p: Param, list: File[]) => {
    const next = { ...(values.files ?? {}) };
    if (list.length) next[p.name] = list;
    else delete next[p.name];
    onValues({ ...values, files: next }, true);
  };
  const get = (p: Param): string[] => valuesOf(p, values);
  return (
    <table class="rab-n-params" data-testid="params">
      <tbody>
        {sorted.map((p) => {
          const list = get(p);
          const isFile = p.in === 'form' && p.type === 'File';
          return (
            <tr key={p.in + ':' + p.name}>
              <td class="rab-n-param-name">
                {p.name}
                {p.required && <span class="rab-n-required" title="Required" aria-hidden="true">*</span>}
              </td>
              <td class="rab-n-param-value">
                {isFile ? (
                  <FileParamField
                    param={p}
                    files={values.files?.[p.name] ?? []}
                    textValues={list}
                    onFiles={(f) => setFiles(p, f)}
                    onText={(t) => set(p, t)}
                  />
                ) : (
                  <>
                    {list.map((v, i) => {
                      const check = checkAt(p, v, i, list, regexOf(p, regexes));
                      return (
                        <div class="rab-n-param-row" key={i}>
                          <ParamInput param={p} value={v} invalid={check?.state === 'warn' && !!v.trim()} onChange={(nv) => set(p, list.map((x, j) => (j === i ? nv : x)))} />
                          <CheckMark check={check} />
                          {p.repeating && list.length > 1 && (
                            <button class="rab-n-icon" aria-label={`Remove ${p.name} value ${i + 1}`}
                                    {...tipProps({ title: 'Remove value', body: `Remove value #${i + 1} for ${p.name}.` })}
                                    onClick={() => set(p, list.filter((_, j) => j !== i))}>×</button>
                          )}
                        </div>
                      );
                    })}
                    {p.repeating && (p.in === 'query' || p.in === 'form') && (
                      <button class="rab-n-link" onClick={() => set(p, [...list, ''])}
                              {...tipProps({ title: 'Add another value', body: `Append another ${p.name} parameter entry to the request.` })}>+ value</button>
                    )}
                  </>
                )}
                {p.description && <div class="rab-n-param-desc" data-testid="param-desc">{p.description}</div>}
              </td>
              <td class="rab-n-param-meta">
                <span class={'rab-n-in rab-n-in-' + p.in}>{p.in}</span>{' '}
                <ParamTypeLabel param={p} opKey={opKey} onOpenClass={onOpenClass} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ParamTypeLabel({ param, opKey, onOpenClass }: {
  param: Param; opKey: string; onOpenClass?: (req: OpenTabRequest) => void;
}) {
  if (!onOpenClass) return <>{param.type}</>;
  const javaType = param.javaType;
  if (javaType && (javaType.includes('<') || javaType.includes('$'))) {
    return <code class="rab-n-param-jtype"><JavaTypeExpr typeExpr={javaType} opKey={opKey} onOpenClass={onOpenClass} /></code>;
  }
  const fqcn = (javaType && javaType.includes('.')) ? javaType : fallbackJavaType(param.type);
  if (!fqcn) return <>{param.type}</>;
  return (
    <JavaTypeButton fqcn={fqcn} opKey={opKey} onOpenClass={onOpenClass}>
      {param.type}
    </JavaTypeButton>
  );
}

function ParamInput({ param, value, invalid, onChange }: { param: Param; value: string; invalid?: boolean; onChange: (v: string) => void }) {
  const cls = 'rab-n-input' + (invalid ? ' is-warn' : '');
  const type = param.type.toLowerCase();
  const placeholder = param.default && param.in !== 'path' ? 'default: ' + param.default : param.required ? 'required' : '';
  const on = (e: Event) => onChange((e.target as HTMLInputElement | HTMLSelectElement).value);
  const label = `${param.name} (${param.in} parameter${param.required ? ', required' : ''})`;
  if (type === 'boolean' || (param.options && param.options.length)) {
    const options = type === 'boolean' ? ['true', 'false'] : param.options!;
    return (
      <select class={cls} value={value} onChange={on} name={param.name} aria-label={label} aria-invalid={invalid ? 'true' : undefined}>
        <option value="">{placeholder || '(not set)'}</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
        {value && !options.includes(value) && <option value={value}>{value}</option>}
      </select>
    );
  }
  return (
    <input
      class={cls}
      name={param.name}
      aria-label={label}
      aria-invalid={invalid ? 'true' : undefined}
      inputMode={INTEGER_TYPES.has(type) ? 'numeric' : DECIMAL_TYPES.has(type) ? 'decimal' : undefined}
      value={value}
      placeholder={placeholder}
      onInput={on}
    />
  );
}
