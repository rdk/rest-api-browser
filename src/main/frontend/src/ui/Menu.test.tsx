// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearEscapeStack } from '../lib/overlay';
import { Menu } from './Menu';

afterEach(() => {
  render(null, document.body);
  clearEscapeStack();
  document.body.innerHTML = '';
});

describe('ui/Menu', () => {
  it('opens, navigates vertical and horizontal choice items by keyboard, and closes on Escape', async () => {
    const onReset = vi.fn();
    const onDark = vi.fn();
    render(
      <Menu
        label="More actions"
        items={[
          { id: 'reset', label: 'Reset layout', onSelect: onReset, testId: 'm-reset' },
          {
            id: 'mode',
            label: 'Theme mode',
            choices: [
              { id: 'light', label: 'Light', icon: null, checked: true, onSelect: () => undefined, testId: 'm-light' },
              { id: 'dark', label: 'Dark', icon: null, checked: false, onSelect: onDark, testId: 'm-dark' },
            ],
          },
        ]}
      />,
      document.body,
    );
    const btn = document.querySelector('[data-testid=menu-button]') as HTMLButtonElement;
    btn.click();
    await new Promise((r) => setTimeout(r, 20));

    const menu = document.querySelector('[data-testid=menu]') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(document.activeElement).toBe(document.querySelector('[data-testid=m-reset]'));

    // ArrowDown jumps into the checked item of the choices strip
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(document.querySelector('[data-testid=m-light]'));

    // ArrowRight steps horizontally inside the choices strip
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(document.querySelector('[data-testid=m-dark]'));

    // Escape closes the menu and restores focus to trigger button
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector('[data-testid=menu]')).toBeNull();
    expect(document.activeElement).toBe(btn);
  });
});
