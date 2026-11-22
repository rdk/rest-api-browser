import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

export const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function MethodBadge({ method }: { method: string }) {
  const m = method.toUpperCase();
  const cls = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m) ? m.toLowerCase() : 'other';
  return <span class={'rab-n-method rab-n-method-' + cls}>{m === 'DELETE' ? 'DEL' : m}</span>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: {
  tabs: { id: T; label: ComponentChildren }[]; value: T; onChange: (id: T) => void;
}) {
  return (
    <div class="rab-n-tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === value}
          class={'rab-n-tab' + (t.id === value ? ' on' : '')}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function CopyButton({ text, label, testId }: { text: () => string; label: string; testId?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    const value = text();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // older browsers or a page without clipboard permission
      const area = document.createElement('textarea');
      area.value = value;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1200);
  };
  return (
    <button class="rab-n-button" onClick={copy} data-testid={testId}>
      {done ? 'Copied' : label}
    </button>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
