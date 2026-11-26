import type { DecompilerId } from '../../core/details';
import { tipProps } from '../../core/uitips';

const DECOMPILER_HOME: Record<DecompilerId, { url: string; fallback: string }> = {
  cfr: { url: 'https://github.com/leibnitz27/cfr', fallback: 'CFR' },
  vineflower: { url: 'https://github.com/Vineflower/vineflower', fallback: 'Vineflower' },
};

/** Decompiler name & version as a link to its GitHub repository, placed immediately left of the toggle. */
export function DecompilerLink({ decompiler, label, testId }: {
  decompiler: DecompilerId; label?: string; testId?: string;
}) {
  if (!label) return null;
  const info = DECOMPILER_HOME[decompiler];
  return (
    <a
      class="rab-n-decompiler-link"
      href={info.url}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={testId}
      {...tipProps({
        title: `${label} on GitHub`,
        body: `Open the ${info.fallback} bytecode decompiler repository on GitHub in a new tab.`,
      })}
    >
      {label}
    </a>
  );
}

/** In-place segmented toggle between Vineflower and CFR. */
export function DecompilerToggle({ value, onChange }: { value: DecompilerId; onChange: (d: DecompilerId) => void }) {
  return (
    <span class="rab-n-seg" role="group" aria-label="Decompiler" data-testid="decompiler-toggle">
      <button
        type="button"
        class={'rab-n-seg-btn' + (value === 'vineflower' ? ' on' : '')}
        aria-pressed={value === 'vineflower'}
        data-testid="decompiler-vineflower"
        onClick={() => onChange('vineflower')}
        {...tipProps({
          title: 'Vineflower decompiler',
          body: 'Modern Fernflower fork with clean Java 21 syntax, records, lambdas, and annotations (default).',
        })}
      >
        Vineflower
      </button>
      <button
        type="button"
        class={'rab-n-seg-btn' + (value === 'cfr' ? ' on' : '')}
        aria-pressed={value === 'cfr'}
        data-testid="decompiler-cfr"
        onClick={() => onChange('cfr')}
        {...tipProps({
          title: 'CFR decompiler',
          body: 'Alternative Java bytecode decompiler — useful for comparing tricky bytecode, switches, or exception handling.',
        })}
      >
        CFR
      </button>
    </span>
  );
}

/** Toggle button switching between raw decompiler output and Pretty-reformatted Java source. */
export function PrettyToggle({ pressed, onToggle }: { pressed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      class={'rab-n-quiet rab-n-outline-btn' + (pressed ? ' on' : '')}
      aria-pressed={pressed}
      data-testid="toggle-pretty-source"
      onClick={onToggle}
      {...tipProps({
        title: pressed ? 'Original decompiler output' : 'Pretty-reformat Java',
        body: pressed
          ? 'Showing reformatted code. Click to return to the raw decompiler output.'
          : 'Re-indent to 4 spaces, wrap long annotations and method signatures, and normalize brace spacing.',
      })}
    >
      Pretty
    </button>
  );
}
