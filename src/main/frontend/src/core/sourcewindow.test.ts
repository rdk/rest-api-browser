import { describe, expect, it } from 'vitest';
import { clampBounds, defaultBounds, endpointHref, methodTone, resizeBounds } from './sourcewindow';

describe('sourcewindow', () => {
  it('fits within narrow viewports without overflowing controls offscreen', () => {
    const narrow = clampBounds({ x: 50, y: 50, w: 700, h: 600 }, 400, 300);
    expect(narrow.w).toBeLessThanOrEqual(400 - 16);
    expect(narrow.h).toBeLessThanOrEqual(300 - 16);

    const def = defaultBounds(420, 320);
    expect(def.w).toBeLessThanOrEqual(420 - 16);
    expect(def.x).toBeGreaterThanOrEqual(8);
  });

  it('preserves opposite edges when west or north resize hits the viewport margin', () => {
    const origin = { x: 100, y: 120, w: 600, h: 400 };
    const right = origin.x + origin.w;
    const bottom = origin.y + origin.h;

    const nw = resizeBounds(origin, 'nw', -400, -400, 1280, 800);
    expect(nw.x).toBe(8);
    expect(nw.y).toBe(8);
    expect(nw.x + nw.w).toBe(right);
    expect(nw.y + nw.h).toBe(bottom);

    const wMin = resizeBounds(origin, 'w', 500, 0, 1280, 800);
    expect(wMin.w).toBe(500);
    expect(wMin.x + wMin.w).toBe(right);

    // East, South, NE, SW, SE directions
    const se = resizeBounds(origin, 'se', 150, 100, 1280, 800);
    expect(se).toEqual({ x: 100, y: 120, w: 750, h: 500 });
    const ne = resizeBounds(origin, 'ne', 100, -40, 1280, 800);
    expect(ne).toEqual({ x: 100, y: 80, w: 700, h: 440 });
    const sw = resizeBounds(origin, 'sw', -30, 50, 1280, 800);
    expect(sw).toEqual({ x: 70, y: 120, w: 630, h: 450 });
  });

  it('maps HTTP methods to badge tones and builds deep-link endpoint hrefs', () => {
    expect(methodTone('get')).toBe('get');
    expect(methodTone('DELETE')).toBe('delete');
    expect(methodTone('HEAD')).toBe('other');
    expect(endpointHref('jira:v2:GET:issue/{}')).toContain('op=jira%3Av2%3AGET%3Aissue%2F%7B%7D');
  });
});
