import { useEffect, useRef } from 'preact/hooks';

export type EscapeHandler = () => boolean | void;

export const ESCAPE_PRIORITY = {
  BASE: 10,
  MODAL: 20,
  MENU: 35,
  TOOLTIP: 40,
} as const;

interface Entry {
  id: number;
  priority: number;
  handler: EscapeHandler;
  released: boolean;
}

const stack: Entry[] = [];
let nextId = 1;
let attached = false;

function handleKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  const snapshot = [...stack].sort((a, b) => (b.priority - a.priority) || (b.id - a.id));
  for (const entry of snapshot) {
    if (entry.released) continue;
    const res = entry.handler();
    if (res !== false) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      return;
    }
  }
}

function syncListener(): void {
  if (typeof document === 'undefined') return;
  if (stack.length > 0 && !attached) {
    document.addEventListener('keydown', handleKeyDown, true);
    attached = true;
  } else if (stack.length === 0 && attached) {
    document.removeEventListener('keydown', handleKeyDown, true);
    attached = false;
  }
}

/**
 * Registers an Escape handler on a priority-ordered LIFO stack.
 * When `Escape` is pressed, the highest-priority (tie-broken by most-recently pushed) handler runs first;
 * returning `false` lets an underlying handler process it, while returning `true` or `undefined` claims and stops the event.
 */
export function pushEscape(handler: EscapeHandler, priority: number = ESCAPE_PRIORITY.BASE): () => void {
  const entry: Entry = { id: nextId++, priority, handler, released: false };
  stack.push(entry);
  syncListener();
  return () => {
    if (entry.released) return;
    entry.released = true;
    const idx = stack.indexOf(entry);
    if (idx >= 0) stack.splice(idx, 1);
    syncListener();
  };
}

/** Clears all registered Escape handlers and detaches the capture listener (for tests). */
export function clearEscapeStack(): void {
  for (const entry of stack) entry.released = true;
  stack.length = 0;
  syncListener();
}

/**
 * Keeps an Escape handler at its insertion position in the stack while `active` is true.
 * Updates the handler ref without re-pushing so re-renders never reorder layers.
 */
export function useEscape(active: boolean, onEscape: EscapeHandler, priority: number = ESCAPE_PRIORITY.BASE): void {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    if (!active) return;
    return pushEscape(() => ref.current(), priority);
  }, [active, priority]);
}
