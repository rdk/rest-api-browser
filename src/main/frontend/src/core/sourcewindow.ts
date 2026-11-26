import { formatState } from './router';

export const MIN_MODAL_W = 500;
export const MIN_MODAL_H = 320;
export const DEFAULT_OUTLINE_W = 240;
export const MIN_OUTLINE_W = 150;
export const MAX_OUTLINE_SHARE = 0.65;

export interface WindowBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const MARGIN = 8;

const minSize = (vw: number, vh: number) => ({
  minW: Math.min(MIN_MODAL_W, Math.max(240, vw - 2 * MARGIN)),
  minH: Math.min(MIN_MODAL_H, Math.max(200, vh - 2 * MARGIN)),
});

export function defaultBounds(
  vw = typeof document !== 'undefined' ? (document.documentElement.clientWidth || window.innerWidth) : 1280,
  vh = typeof document !== 'undefined' ? (document.documentElement.clientHeight || window.innerHeight) : 800,
): WindowBounds {
  const { minW, minH } = minSize(vw, vh);
  const w = Math.min(1180, Math.min(Math.max(minW, vw - 48), vw - 2 * MARGIN));
  const h = Math.min(840, Math.min(Math.max(minH, Math.round(vh * 0.85)), vh - 2 * MARGIN));
  return {
    x: Math.max(MARGIN, Math.round((vw - w) / 2)),
    y: Math.max(MARGIN, Math.round((vh - h) / 2)),
    w: Math.max(minW, Math.round(w)),
    h: Math.max(minH, Math.round(h)),
  };
}

export function clampBounds(
  b: WindowBounds,
  vw = typeof document !== 'undefined' ? (document.documentElement.clientWidth || window.innerWidth) : 1280,
  vh = typeof document !== 'undefined' ? (document.documentElement.clientHeight || window.innerHeight) : 800,
): WindowBounds {
  const { minW, minH } = minSize(vw, vh);
  const maxW = Math.max(minW, vw - 2 * MARGIN);
  const maxH = Math.max(minH, vh - 2 * MARGIN);
  const w = Math.max(minW, Math.min(maxW, b.w));
  const h = Math.max(minH, Math.min(maxH, b.h));
  const x = Math.max(MARGIN, Math.min(vw - Math.min(w, 160) - MARGIN, b.x));
  const y = Math.max(MARGIN, Math.min(vh - 48, b.y));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * Resizes a floating window from `origin` along `dir` while strictly preserving opposite edges:
 * clamping `x`/`y` to the viewport margin shrinks width/height instead of pushing the right/bottom edge.
 */
export function resizeBounds(
  origin: WindowBounds,
  dir: ResizeDir,
  dx: number,
  dy: number,
  vw: number,
  vh: number,
): WindowBounds {
  const { minW, minH } = minSize(vw, vh);
  const right = origin.x + origin.w;
  const bottom = origin.y + origin.h;
  let { x, y, w, h } = origin;

  if (dir.includes('e')) {
    w = Math.max(minW, Math.min(Math.max(minW, vw - MARGIN - origin.x), origin.w + dx));
  }
  if (dir.includes('s')) {
    h = Math.max(minH, Math.min(Math.max(minH, vh - MARGIN - origin.y), origin.h + dy));
  }
  if (dir.includes('w')) {
    const nextX = Math.max(MARGIN, Math.min(right - minW, origin.x + dx));
    x = nextX;
    w = right - nextX;
  }
  if (dir.includes('n')) {
    const nextY = Math.max(MARGIN, Math.min(bottom - minH, origin.y + dy));
    y = nextY;
    h = bottom - nextY;
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

export function methodTone(m: string): string {
  const up = m.toUpperCase();
  return up === 'GET' || up === 'POST' || up === 'PUT' || up === 'PATCH' || up === 'DELETE' ? up.toLowerCase() : 'other';
}

export function endpointHref(opKey: string, pathname?: string): string {
  const base = pathname ?? (typeof location !== 'undefined' ? location.pathname : '/plugins/servlet/rest-api-browser');
  return base + formatState({ op: opKey, path: {}, q: {}, h: {} });
}
