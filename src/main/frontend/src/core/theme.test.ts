// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-color-mode');
  document.documentElement.removeAttribute('data-color-mode-auto');
});

describe('theme', () => {
  it('validates mode and resolves skins including legacy calm alias', async () => {
    const { isMode, skinOf } = await import('./theme');
    expect(isMode('light')).toBe(true);
    expect(isMode('dark')).toBe(true);
    expect(isMode('system')).toBe(true);
    expect(isMode('auto')).toBe(false);

    expect(skinOf('vivid')).toBe('vivid');
    expect(skinOf('calm')).toBe('navy');
    expect(skinOf('unknown')).toBe('balanced');
    expect(skinOf(undefined)).toBe('balanced');
  });

  it('applies fixed and system color modes with live prefers-color-scheme updates', async () => {
    let matches = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      get matches() { return matches; },
      addEventListener: (_ev: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_ev: string, fn: () => void) => listeners.delete(fn),
    })));

    const { applyMode } = await import('./theme');
    const cleanupLight = applyMode('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark:dark light:light');
    expect(document.documentElement.getAttribute('data-color-mode')).toBe('light');
    expect(document.documentElement.hasAttribute('data-color-mode-auto')).toBe(false);
    cleanupLight();

    const cleanupSys = applyMode('system');
    expect(document.documentElement.hasAttribute('data-color-mode-auto')).toBe(true);
    expect(document.documentElement.getAttribute('data-color-mode')).toBe('dark');
    matches = false;
    listeners.forEach((fn) => fn());
    expect(document.documentElement.getAttribute('data-color-mode')).toBe('light');
    cleanupSys();
    expect(listeners.size).toBe(0);
  });

  it('reads PRODUCT_MODE from documentElement attributes at module load', async () => {
    document.documentElement.setAttribute('data-color-mode-auto', '');
    vi.resetModules();
    expect((await import('./theme')).PRODUCT_MODE).toBe('system');

    document.documentElement.removeAttribute('data-color-mode-auto');
    document.documentElement.setAttribute('data-color-mode', 'dark');
    vi.resetModules();
    expect((await import('./theme')).PRODUCT_MODE).toBe('dark');
  });
});
