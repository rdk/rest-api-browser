import { usePointerDrag } from './usePointerDrag';

export interface SplitHandleProps {
  /** 'vertical' (vertical bar, left/right resize) or 'horizontal' (horizontal bar, up/down resize). */
  orientation: 'vertical' | 'horizontal';
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  onCommit?: (finalValue: number) => void;
  /** Converts 1 CSS pixel of pointer movement along the axis into value units (default: 1). */
  valuePerPixel?: () => number;
  invert?: boolean;
  step?: number;
  bigStep?: number;
  className?: string;
  testId?: string;
  title?: string;
  ariaValueText?: string;
  tipAttrs?: Partial<Record<`data-${string}`, string>>;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/**
 * Accessible `role="separator"` splitter supporting pointer capture drags, `window.blur` cleanup,
 * rAF batching, and Arrow / Home / End keyboard adjustment.
 */
export function SplitHandle({
  orientation,
  label,
  value,
  min,
  max,
  onChange,
  onCommit,
  valuePerPixel,
  invert = false,
  step = 24,
  bigStep = 96,
  className,
  testId,
  title,
  ariaValueText,
  tipAttrs,
}: SplitHandleProps) {
  const { begin } = usePointerDrag(true);
  const effectiveMax = Math.max(min, max);
  const clampedNow = clamp(Math.round(value), min, effectiveMax);

  const onPointerDown = (e: PointerEvent) => {
    const startVal = clampedNow;
    const startPos = orientation === 'vertical' ? e.clientX : e.clientY;
    const scale = valuePerPixel ? valuePerPixel() : 1;
    let latest = startVal;
    begin(e, {
      onMove: (ev, _s, moved) => {
        if (!moved) return;
        const pos = orientation === 'vertical' ? ev.clientX : ev.clientY;
        const delta = (pos - startPos) * (invert ? -1 : 1) * scale;
        latest = clamp(Math.round(startVal + delta), min, effectiveMax);
        onChange(latest);
      },
      onEnd: (_ev, _s, moved) => {
        if (moved) onCommit?.(latest);
      },
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const delta = e.shiftKey ? bigStep : step;
    const sign = invert ? -1 : 1;
    let next: number | null = null;
    if (orientation === 'vertical') {
      if (e.key === 'ArrowRight') next = clampedNow + delta * sign;
      else if (e.key === 'ArrowLeft') next = clampedNow - delta * sign;
    } else {
      if (e.key === 'ArrowDown') next = clampedNow + delta * sign;
      else if (e.key === 'ArrowUp') next = clampedNow - delta * sign;
    }
    if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = effectiveMax;
    if (next === null) return;
    e.preventDefault();
    const clamped = clamp(Math.round(next), min, effectiveMax);
    onChange(clamped);
    onCommit?.(clamped);
  };

  return (
    <div
      class={className}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={effectiveMax}
      aria-valuenow={clampedNow}
      aria-valuetext={ariaValueText}
      title={title}
      data-testid={testId}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      {...tipAttrs}
    />
  );
}
