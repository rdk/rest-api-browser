/**
 * Pure helpers for the delegated rich UI tooltip layer (`UiTipLayer`).
 * Any button, link, tab, or badge carries `data-tip` (plus optional `data-tip-title`, `data-tip-key`,
 * `data-tip-note`, `data-tip-tone`) without needing wrapper elements that could disturb flex/segmented layouts.
 */

export type UiTipTone = 'info' | 'warn' | 'danger';

export interface UiTipSpec {
  title?: string;
  body: string;
  shortcut?: string;
  note?: string;
  tone?: UiTipTone;
}

export interface UiTipAttrs {
  'data-tip': string;
  'data-tip-title'?: string;
  'data-tip-key'?: string;
  'data-tip-note'?: string;
  'data-tip-tone'?: UiTipTone;
}

/** Builds `data-tip*` attributes cleanly for JSX spread (`{...tipProps(...)}`). */
export function tipProps(spec: UiTipSpec | null | undefined): Partial<UiTipAttrs> {
  if (!spec || !spec.body) return {};
  const attrs: Partial<UiTipAttrs> = { 'data-tip': spec.body };
  if (spec.title) attrs['data-tip-title'] = spec.title;
  if (spec.shortcut) attrs['data-tip-key'] = spec.shortcut;
  if (spec.note) attrs['data-tip-note'] = spec.note;
  if (spec.tone) attrs['data-tip-tone'] = spec.tone;
  return attrs;
}

/** Reads a `UiTipSpec` from a DOM element's `data-tip*` attributes, or null when absent/empty. */
export function readTipAttrs(el: Pick<Element, 'getAttribute'> | null | undefined): UiTipSpec | null {
  if (!el) return null;
  const body = el.getAttribute('data-tip')?.trim();
  if (!body) return null;
  const title = el.getAttribute('data-tip-title')?.trim() || undefined;
  const shortcut = el.getAttribute('data-tip-key')?.trim() || undefined;
  const note = el.getAttribute('data-tip-note')?.trim() || undefined;
  const rawTone = el.getAttribute('data-tip-tone')?.trim();
  const tone: UiTipTone | undefined = rawTone === 'warn' || rawTone === 'danger' || rawTone === 'info' ? rawTone : undefined;
  return { title, body, shortcut, note, tone };
}

/**
 * Splits a shortcut string such as `"Ctrl+Enter"` or `"Ctrl+Shift+T"` into individual key cap labels
 * so the tooltip can render each key in a `<kbd>` element.
 */
export function splitShortcutKeys(shortcut: string): string[] {
  const s = shortcut.trim();
  if (!s) return [];
  if (s === '+') return ['+'];
  if (s.endsWith('++')) {
    const head = s.slice(0, -2).split('+').map((x) => x.trim()).filter(Boolean);
    return [...head, '+'];
  }
  return s
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
}

export interface RectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface TipPlacement {
  left: number;
  top: number;
  above: boolean;
}

/**
 * Positions a fixed-position rich tooltip near `anchor`, preferring directly below and centered horizontally
 * on small targets (or left-aligned on wide targets), flipping above when there isn't room below, and clamping
 * strictly inside the viewport with an 8 px margin.
 */
export function placeFloatingTip(
  anchor: RectLike,
  tip: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 8,
  margin = 8,
): TipPlacement {
  const spaceBelow = viewport.height - anchor.bottom - margin;
  const spaceAbove = anchor.top - margin;
  const above = spaceBelow < tip.height + gap && spaceAbove > spaceBelow;
  let top = above ? anchor.top - tip.height - gap : anchor.bottom + gap;
  top = Math.max(margin, Math.min(viewport.height - tip.height - margin, top));

  // Center under compact buttons; left-align under wide controls
  const idealLeft = anchor.width <= 140
    ? anchor.left + (anchor.width - tip.width) / 2
    : anchor.left;
  const maxLeft = Math.max(margin, viewport.width - tip.width - margin);
  const left = Math.round(Math.max(margin, Math.min(maxLeft, idealLeft)));
  return { left, top: Math.round(top), above };
}
