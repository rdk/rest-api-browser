/** The skins of skins.css, in the menu's order; the first is the default. */
export const SKINS = [
  { id: 'balanced', label: 'Balanced', hint: 'Blue to indigo, soft gradients' },
  { id: 'vivid', label: 'Vivid', hint: 'Bold gradients in many colours' },
  { id: 'navy', label: 'Calm', hint: 'Flat and quiet, a deep navy header' },
] as const;

export type Mode = 'light' | 'dark' | 'system';

/**
 * The product's own colour mode when the page loaded, before any choice here: its <html> carries data-color-mode
 * (light or dark) and, when it follows the system, data-color-mode-auto. Read once, at load.
 */
export const PRODUCT_MODE: Mode = (() => {
  const h = typeof document !== 'undefined' ? document.documentElement : null;
  if (!h) return 'light';
  if (h.hasAttribute('data-color-mode-auto')) return 'system';
  return h.getAttribute('data-color-mode') === 'dark' ? 'dark' : 'light';
})();

export const isMode = (m: unknown): m is Mode => m === 'light' || m === 'dark' || m === 'system';

/** A stored skin, or the default; "calm" (a light header, dropped) becomes the navy one. */
export const skinOf = (s: string | undefined): string =>
  s === 'calm' ? 'navy' : SKINS.some((k) => k.id === s) ? s! : SKINS[0].id;

/**
 * Applies a colour mode to this page: the product's design tokens switch on <html>'s data-color-mode (both its light
 * and dark themes are loaded), "system" follows the browser's preference and its changes. Returns the clean-up.
 */
export function applyMode(mode: Mode): () => void {
  const h = document.documentElement;
  const themes = (h.getAttribute('data-theme') ?? '').split(/\s+/).filter(Boolean);
  for (const t of ['dark:dark', 'light:light']) if (!themes.includes(t)) themes.push(t);
  if (h.getAttribute('data-theme') !== themes.join(' ')) h.setAttribute('data-theme', themes.join(' '));
  if (mode !== 'system') {
    h.removeAttribute('data-color-mode-auto');
    h.setAttribute('data-color-mode', mode);
    return () => undefined;
  }
  const media = matchMedia('(prefers-color-scheme: dark)');
  const follow = () => h.setAttribute('data-color-mode', media.matches ? 'dark' : 'light');
  h.setAttribute('data-color-mode-auto', '');
  follow();
  media.addEventListener('change', follow);
  return () => media.removeEventListener('change', follow);
}
