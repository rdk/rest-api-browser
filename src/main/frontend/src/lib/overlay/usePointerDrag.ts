import { useCallback, useEffect, useRef } from 'preact/hooks';

export interface PointerDragCallbacks<T = void> {
  /** Initial state captured at pointerdown; returned value is passed to move/end. */
  start?: (e: PointerEvent) => T;
  onMove: (e: PointerEvent, state: T, moved: boolean) => void;
  onEnd?: (e: PointerEvent | FocusEvent | null, state: T, moved: boolean) => void;
  /** Threshold in CSS pixels before `moved` becomes true (default: 0). */
  moveThreshold?: number;
  /** Throttle move callbacks with requestAnimationFrame (default: true when available). */
  raf?: boolean;
}

/**
 * Starts a pointer drag session with optional pointer capture, primary-button guard,
 * `window` blur/pointercancel recovery, and rAF batching. Returns an idempotent stop function.
 */
export function startPointerDrag<T = void>(
  downEvent: PointerEvent,
  callbacks: PointerDragCallbacks<T>,
): (() => void) | null {
  if (downEvent.button !== 0) return null;
  downEvent.preventDefault();

  const target = downEvent.currentTarget as HTMLElement | null;
  const pointerId = downEvent.pointerId;
  const startX = downEvent.clientX;
  const startY = downEvent.clientY;
  const threshold = callbacks.moveThreshold ?? 0;
  const useRaf = callbacks.raf !== false && typeof requestAnimationFrame === 'function';

  const state = (callbacks.start ? callbacks.start(downEvent) : undefined) as T;
  let moved = false;
  let ended = false;
  let pendingEvent: PointerEvent | null = null;
  let rafId = 0;

  try {
    target?.setPointerCapture?.(pointerId);
  } catch {
    // Synthetic or detached elements in tests may not support setPointerCapture.
  }

  const isForeignPointer = (e: PointerEvent) =>
    typeof pointerId === 'number' && typeof e.pointerId === 'number' && e.pointerId !== pointerId;

  const flushMove = (e: PointerEvent) => {
    if (!moved) {
      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);
      if (dx > threshold || dy > threshold) moved = true;
    }
    callbacks.onMove(e, state, moved);
  };

  const finish = (endEvent: PointerEvent | FocusEvent | null, aborted = false) => {
    if (ended) return;
    ended = true;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (pendingEvent) {
      const last = pendingEvent;
      pendingEvent = null;
      if (!aborted) flushMove(last);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', onBlur);
    }
    try {
      if (target?.hasPointerCapture?.(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
    } catch {
      // Ignore if capture was already released.
    }
    callbacks.onEnd?.(endEvent, state, moved);
  };

  const onMove = (e: PointerEvent) => {
    if (ended || isForeignPointer(e)) return;
    if (useRaf) {
      pendingEvent = e;
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          if (!ended && pendingEvent) {
            const next = pendingEvent;
            pendingEvent = null;
            flushMove(next);
          }
        });
      }
    } else {
      flushMove(e);
    }
  };

  const onUp = (e: PointerEvent) => {
    if (isForeignPointer(e)) return;
    finish(e);
  };
  const onBlur = (e: FocusEvent) => finish(e);

  if (typeof window !== 'undefined') {
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onBlur);
  }

  return () => finish(null, true);
}

/**
 * Manages pointer drag lifetimes inside a component, automatically aborting any active drag
 * when `active` flips to `false` or on unmount.
 */
export function usePointerDrag(active = true) {
  const stopRef = useRef<(() => void) | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const stop = useCallback(() => {
    const current = stopRef.current;
    stopRef.current = null;
    current?.();
  }, []);

  useEffect(() => {
    if (!active) stop();
  }, [active, stop]);

  useEffect(() => stop, [stop]);

  const begin = useCallback(<T = void>(e: PointerEvent, callbacks: PointerDragCallbacks<T>) => {
    if (!activeRef.current || e.button !== 0) return null;
    stop();
    let wrappedStop: (() => void) | null = null;
    wrappedStop = startPointerDrag<T>(e, {
      ...callbacks,
      onEnd: (endEvent, state, moved) => {
        if (stopRef.current === wrappedStop) stopRef.current = null;
        callbacks.onEnd?.(endEvent, state, moved);
      },
    });
    stopRef.current = wrappedStop;
    return wrappedStop;
  }, [stop]);

  return { begin, stop };
}
