import { useEffect, useMemo, useState } from 'preact/hooks';
import { fetchSource, forgetSource, peekSource, type DecompilerId, type OperationSource } from '../../core/details';
import { describeDetailsError } from '../../core/detailserror';
import { formatJavaSource } from '../../lib/java-source';
import type { OpenTabRequest } from '../../core/sourcetabs';
import { tipProps } from '../../core/uitips';
import { CopyButton } from '../bits';
import { DecompilerLink, DecompilerToggle, PrettyToggle } from '../source/DecompilerControls';
import { SourceCode } from '../source/SourceCodeView';

/**
 * Top action bar and optional inline method decompiler on the Method page.
 * "Decompile class" opens the full class in the tabbed SourceDialog focused on this handler method.
 */
export function InlineMethodSource({
  baseUrl, opKey, className, bundleId, focusMethod, focusParamCount,
  decompiler, onDecompiler, pretty, onPretty, onOpenClass,
}: {
  baseUrl: string;
  opKey: string;
  className: string;
  bundleId?: number;
  focusMethod?: string;
  focusParamCount?: number;
  decompiler: DecompilerId;
  onDecompiler: (d: DecompilerId) => void;
  pretty: boolean;
  onPretty?: () => void;
  onOpenClass?: (req: OpenTabRequest) => void;
}) {
  const [open, setOpen] = useState(false);
  const [localPretty, setLocalPretty] = useState(false);
  const isPretty = onPretty ? pretty : localPretty;
  const togglePretty = onPretty ?? (() => setLocalPretty((p) => !p));

  const query = useMemo(() => ({ op: opKey, scope: 'method' as const, decompiler }), [opKey, decompiler]);
  const [src, setSrc] = useState<OperationSource | null>(() => peekSource(query, baseUrl));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const displaySource = useMemo(() => (src ? (isPretty ? formatJavaSource(src.source) : src.source) : ''), [src, isPretty]);

  useEffect(() => {
    if (!open) return;
    const cached = peekSource(query, baseUrl);
    if (cached) {
      setSrc(cached);
      setLoading(false);
      setError(null);
      return;
    }
    let live = true;
    // Clear previous decompiler's source immediately so errors never show stale controls or output.
    setSrc(null);
    setLoading(true);
    setError(null);
    fetchSource(baseUrl, query).then(
      (s) => {
        if (!live) return;
        setSrc(s);
        setLoading(false);
      },
      (e) => {
        if (!live) return;
        setSrc(null);
        setError(describeDetailsError(e, 'source'));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [open, baseUrl, query, attempt]);

  const retry = () => {
    forgetSource(query, baseUrl);
    setSrc(null);
    setAttempt((a) => a + 1);
  };

  const openClassDialog = () => onOpenClass?.({
    target: src?.class ?? className,
    candidates: [src?.class ?? className],
    fromBundle: src?.bundleId ?? bundleId,
    opKey,
    focusMethod,
    focusParamCount,
  });

  if (!open) {
    return (
      <div class="rab-n-source-actions rab-n-source-top" data-testid="java-source">
        {onOpenClass && (
          <button
            type="button"
            class="rab-n-button"
            data-testid="load-class-source"
            onClick={openClassDialog}
            {...tipProps({ title: 'Decompile full class', body: 'Open the entire handler class in the floating tabbed decompiler window, scrolled to this method.' })}
          >
            Decompile class
          </button>
        )}
        <button
          type="button"
          class="rab-n-button"
          data-testid="load-source"
          onClick={() => setOpen(true)}
          {...tipProps({ title: 'Decompile method inline', body: 'Decompile just this handler method and display it right here on the Method page.' })}
        >
          Decompile method
        </button>
      </div>
    );
  }

  return (
    <div class="rab-n-java-source rab-n-source-top" data-testid="java-source">
      <div class="rab-n-java-head">
        <h4 class="rab-n-java-title">Method source</h4>
        {src && !error && src.totalLines && (
          <span class="rab-n-subtle">
            {src.totalLines.toLocaleString()} lines
          </span>
        )}
        <span class="rab-n-java-tools">
          <DecompilerLink decompiler={decompiler} label={!loading && !error ? src?.decompiler : undefined} testId="java-source-engine" />
          <DecompilerToggle value={decompiler} onChange={onDecompiler} />
          <PrettyToggle pressed={isPretty} onToggle={togglePretty} />
          {onOpenClass && (
            <button
              type="button"
              class="rab-n-quiet"
              data-testid="load-class-source"
              {...tipProps({ title: 'Decompile full class', body: 'Open the complete handler class in the floating tabbed decompiler window.' })}
              onClick={openClassDialog}
            >
              Decompile class
            </button>
          )}
          {src && !error && (
            <CopyButton quiet label="Copy source" tip={{ title: 'Copy source code', body: 'Copy the currently displayed Java method source to your clipboard.' }} text={() => displaySource} />
          )}
          <button
            type="button"
            class="rab-n-quiet"
            onClick={() => setOpen(false)}
            {...tipProps({ title: 'Hide inline source', body: 'Collapse the inline decompiled method block.' })}
          >
            Hide
          </button>
        </span>
      </div>
      {loading ? (
        <div class="rab-n-subtle" role="status">
          <span class="rab-n-spinner" aria-hidden="true" /> Decompiling method with {decompiler === 'vineflower' ? 'Vineflower' : 'CFR'}…
        </div>
      ) : error ? (
        <div class="rab-n-java-error" role="alert">
          {error}{' '}
          <button type="button" class="rab-n-quiet" onClick={retry}>Try again</button>
        </div>
      ) : src ? (
        <SourceCode
          source={displaySource}
          className={src.class}
          refs={src.refs}
          bundleId={src.bundleId}
          opKey={opKey}
          onOpenClass={onOpenClass ?? (() => undefined)}
          decompiler={decompiler}
          pretty={isPretty}
          maxAutoHeight={460}
          testId="java-source-code"
        />
      ) : null}
    </div>
  );
}
