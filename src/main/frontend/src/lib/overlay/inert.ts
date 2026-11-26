const inertCounts = new WeakMap<HTMLElement, number>();
const preExistingInert = new WeakSet<HTMLElement>();
const listeners = new Set<() => void>();

function notifyInertChange(): void {
  for (const fn of listeners) fn();
}

/** Subscribes to `inert` attribute additions/removals triggered via `acquireInert`. */
export function onInertChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Ref-counted `inert` guard for stacked overlays (e.g. a maximized pane + a floating modal).
 * Preserves any pre-existing `inert` attribute set outside this guard, and makes each release idempotent.
 */
export function acquireInert(elements: readonly (HTMLElement | null | undefined)[]): () => void {
  const unique: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  let changed = false;
  for (const el of elements) {
    if (!el || seen.has(el)) continue;
    seen.add(el);
    unique.push(el);
    const next = (inertCounts.get(el) ?? 0) + 1;
    inertCounts.set(el, next);
    if (next === 1) {
      if (el.hasAttribute('inert')) preExistingInert.add(el);
      else {
        el.setAttribute('inert', '');
        changed = true;
      }
    }
  }
  if (changed) notifyInertChange();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    let releaseChanged = false;
    for (const el of unique) {
      const cur = inertCounts.get(el) ?? 0;
      if (cur <= 1) {
        inertCounts.delete(el);
        if (preExistingInert.has(el)) preExistingInert.delete(el);
        else {
          el.removeAttribute('inert');
          releaseChanged = true;
        }
      } else {
        inertCounts.set(el, cur - 1);
      }
    }
    if (releaseChanged) notifyInertChange();
  };
}

/** Returns true when `el` (or any ancestor) is currently marked `inert`. */
export function isInsideInert(el: Element | null | undefined): boolean {
  return !!el?.closest('[inert]');
}
