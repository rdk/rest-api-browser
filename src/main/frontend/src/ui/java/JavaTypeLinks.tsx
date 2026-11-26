import type { ComponentChildren } from 'preact';
import { classLabel, parseJavaTypeParts } from '../../lib/java-source';
import type { OpenTabRequest } from '../../core/sourcetabs';

/**
 * Clickable Java type expression (e.g. "java.util.List<com.example.Foo>") where every non-primitive class token
 * triggers the shared rich class tooltip on hover/focus and opens the decompiler dialog on click.
 */
export function JavaTypeExpr({ typeExpr, full = false, fromBundle, opKey, onOpenClass, className }: {
  typeExpr: string;
  full?: boolean;
  fromBundle?: number;
  opKey?: string;
  onOpenClass?: (req: OpenTabRequest) => void;
  className?: string;
}) {
  const parts = parseJavaTypeParts(typeExpr, full);
  if (!onOpenClass) {
    return <span class={className}>{parts.map((p) => p.text).join('')}</span>;
  }
  return (
    <span class={className}>
      {parts.map((p, i) =>
        p.fqcn ? (
          <button
            key={i}
            type="button"
            class="rab-n-jc-link rab-n-jc-type"
            data-class-ref={p.fqcn}
            data-class-candidates={p.fqcn}
            data-class-bundle={fromBundle !== undefined && fromBundle >= 0 ? String(fromBundle) : undefined}
            data-class-op={opKey}
            onClick={(e) => {
              e.stopPropagation();
              onOpenClass({ target: p.fqcn!, candidates: [p.fqcn!], fromBundle, opKey });
            }}
          >
            {p.text}
          </button>
        ) : (
          p.text
        ),
      )}
    </span>
  );
}

/** Single clickable Java class link carrying the data attributes for the shared rich class tooltip. */
export function JavaTypeButton({ fqcn, candidates, fromBundle, opKey, onOpenClass, kind = 'type', children, className }: {
  fqcn: string;
  candidates?: string[];
  fromBundle?: number;
  opKey?: string;
  onOpenClass?: (req: OpenTabRequest) => void;
  kind?: 'type' | 'ann';
  children?: ComponentChildren;
  className?: string;
}) {
  const content = children ?? classLabel(fqcn);
  if (!onOpenClass) {
    return <span class={'rab-n-jc-' + kind + (className ? ' ' + className : '')}>{content}</span>;
  }
  const list = candidates && candidates.length ? candidates : [fqcn];
  return (
    <button
      type="button"
      class={'rab-n-jc-link rab-n-jc-' + kind + (className ? ' ' + className : '')}
      data-class-ref={fqcn}
      data-class-candidates={list.join(',')}
      data-class-bundle={fromBundle !== undefined && fromBundle >= 0 ? String(fromBundle) : undefined}
      data-class-op={opKey}
      onClick={(e) => {
        e.stopPropagation();
        onOpenClass({ target: fqcn, candidates: list, fromBundle, opKey });
      }}
    >
      {content}
    </button>
  );
}
