import { describe, expect, it } from 'vitest';
import { placeFloatingTip, readTipAttrs, splitShortcutKeys, tipProps } from './uitips';

describe('uitips', () => {
  it('builds and reads data-tip attributes cleanly', () => {
    const attrs = tipProps({
      title: 'Send POST request',
      body: 'Execute this write request against the live server.',
      shortcut: 'Ctrl+Enter',
      note: 'May modify data',
      tone: 'warn',
    });
    expect(attrs).toEqual({
      'data-tip': 'Execute this write request against the live server.',
      'data-tip-title': 'Send POST request',
      'data-tip-key': 'Ctrl+Enter',
      'data-tip-note': 'May modify data',
      'data-tip-tone': 'warn',
    });

    const map = new Map(Object.entries(attrs));
    const parsed = readTipAttrs({ getAttribute: (k) => map.get(k) ?? null });
    expect(parsed).toEqual({
      title: 'Send POST request',
      body: 'Execute this write request against the live server.',
      shortcut: 'Ctrl+Enter',
      note: 'May modify data',
      tone: 'warn',
    });

    expect(tipProps(null)).toEqual({});
    expect(readTipAttrs({ getAttribute: () => null })).toBeNull();
  });

  it('splits keyboard shortcuts into key cap labels', () => {
    expect(splitShortcutKeys('Ctrl+Shift+T')).toEqual(['Ctrl', 'Shift', 'T']);
    expect(splitShortcutKeys('Esc')).toEqual(['Esc']);
  });

  it('places tooltips below by default, flips above near bottom edge, and clamps inside viewport', () => {
    const vp = { width: 1200, height: 800 };
    const tip = { width: 260, height: 70 };

    // Centered under a compact button in the middle
    const mid = placeFloatingTip({ left: 500, right: 560, top: 100, bottom: 130, width: 60, height: 30 }, tip, vp);
    expect(mid).toEqual({ left: 400, top: 138, above: false });

    // Clamped near right edge
    const right = placeFloatingTip({ left: 1150, right: 1190, top: 10, bottom: 38, width: 40, height: 28 }, tip, vp);
    expect(right.left).toBe(1200 - 260 - 8);
    expect(right.above).toBe(false);

    // Flipped above near bottom edge
    const bottom = placeFloatingTip({ left: 20, right: 80, top: 750, bottom: 780, width: 60, height: 30 }, tip, vp);
    expect(bottom.above).toBe(true);
    expect(bottom.top).toBe(750 - 70 - 8);
    expect(bottom.left).toBe(8);
  });
});
