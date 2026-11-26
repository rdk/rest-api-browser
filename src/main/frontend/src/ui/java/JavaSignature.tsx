import { useMemo } from 'preact/hooks';
import type { JavaMethod } from '../../core/details';
import {
  annotationTokens, extractAnnotationClassMap, linkAnnotationTokens, toLines, tokenize, type Token,
} from '../../lib/java-source';
import type { OpenTabRequest } from '../../core/sourcetabs';
import { JavaTypeButton, JavaTypeExpr } from './JavaTypeLinks';

/** Coloured Java tokens: annotations, members, types, keywords, strings, numbers and punctuation. */
export function Code({ tokens, classMap, bundleId, opKey, onOpenClass }: {
  tokens: Token[]; classMap?: Map<string, string>; bundleId?: number; opKey?: string; onOpenClass?: (req: OpenTabRequest) => void;
}) {
  if (classMap && classMap.size > 0 && onOpenClass) {
    const spans = linkAnnotationTokens(tokens, classMap);
    return (
      <>
        {spans.map((s, i) => {
          if (s.target) {
            return (
              <JavaTypeButton key={i} fqcn={s.target} fromBundle={bundleId} opKey={opKey} onOpenClass={onOpenClass} kind={s.kind}>
                {s.text}
              </JavaTypeButton>
            );
          }
          return s.kind === 'space' || s.kind === 'name'
            ? s.text
            : <span key={i} class={'rab-n-jc-' + s.kind}>{s.text}</span>;
        })}
      </>
    );
  }
  return (
    <>
      {tokens.map((t, i) => (t.kind === 'space' || t.kind === 'name'
        ? t.text
        : <span key={i} class={'rab-n-jc-' + t.kind}>{t.text}</span>))}
    </>
  );
}

/** An annotation laid out in lines with clickable nested `@Annotation` and `Foo.class` references. */
export function Annotation({ raw, text, max, bundleId, opKey, onOpenClass }: {
  raw: string; text: string; max?: number; bundleId?: number; opKey?: string; onOpenClass?: (req: OpenTabRequest) => void;
}) {
  const classMap = useMemo(() => extractAnnotationClassMap(raw), [raw]);
  return (
    <div class="rab-n-jc-ann-block">
      {toLines(annotationTokens(text, max)).map((l, i) => (
        <div key={i} class="rab-n-jc-line" style={{ paddingLeft: l.indent + 4 + 'ch', textIndent: '-4ch' }}>
          <Code
            tokens={l.tokens}
            classMap={classMap}
            bundleId={bundleId}
            opKey={opKey}
            onOpenClass={onOpenClass}
          />
        </div>
      ))}
    </div>
  );
}

export function CodeList({ items }: { items: string[] }) {
  return <ul class="rab-n-java-list">{items.map((s, i) => <li key={i}><code><Code tokens={tokenize(s)} /></code></li>)}</ul>;
}

/** The handler method formatted like Java source with clickable types and annotations. */
export function MethodCode({ m, full, n, bundleId, opKey, onOpenClass }: {
  m: JavaMethod; full: boolean; n: (s: string) => string; bundleId?: number; opKey: string; onOpenClass?: (req: OpenTabRequest) => void;
}) {
  return (
    <pre class="rab-n-java-code" data-testid="java-signature">
      {m.annotations.map((a, i) => (
        <Annotation key={i} raw={a} text={n(a)} bundleId={bundleId} opKey={opKey} onOpenClass={onOpenClass} />
      ))}
      <Code tokens={tokenize(m.modifiers)} />{m.modifiers && ' '}
      <JavaTypeExpr typeExpr={m.returns} full={full} fromBundle={bundleId} opKey={opKey} onOpenClass={onOpenClass} />{' '}
      <span class="rab-n-jc-method">{m.name}</span>
      <span class="rab-n-jc-punct">(</span>
      {m.parameters.map((p, i) => (
        <div key={i} class="rab-n-jc-param">
          {p.annotations.map((a, k) => (
              <span key={k}>
                <Code tokens={annotationTokens(n(a), 60)} classMap={extractAnnotationClassMap(a)} bundleId={bundleId} opKey={opKey} onOpenClass={onOpenClass} />{' '}
              </span>
          ))}
          <JavaTypeExpr typeExpr={p.type} full={full} fromBundle={bundleId} opKey={opKey} onOpenClass={onOpenClass} />{' '}
          <span class={p.name ? 'rab-n-jc-pname' : 'rab-n-jc-pname rab-n-subtle'}>{p.name ?? 'arg' + i}</span>
          {i < m.parameters.length - 1 && <span class="rab-n-jc-punct">,</span>}
        </div>
      ))}
      <span class="rab-n-jc-punct">)</span>
      {m.throws.length > 0 && (
        <>
          {' '}<span class="rab-n-jc-kw">throws</span>{' '}
          {m.throws.map((t, i) => (
            <span key={i}>
              {i > 0 && ', '}
              <JavaTypeExpr typeExpr={t} full={full} fromBundle={bundleId} opKey={opKey} onOpenClass={onOpenClass} />
            </span>
          ))}
        </>
      )}
    </pre>
  );
}
