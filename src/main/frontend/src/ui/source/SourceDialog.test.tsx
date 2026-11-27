// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDetails } from '../../core/details';
import { openSourceTab, EMPTY_SOURCE_TABS } from '../../core/sourcetabs';
import { clearEscapeStack } from '../../lib/overlay';
import { SourceCode } from './SourceCodeView';
import { SourceDialog } from './SourceDialog';

afterEach(() => {
  render(null, document.body);
  clearEscapeStack();
  clearDetails();
  document.body.innerHTML = '';
});

describe('ui/source/SourceDialog', () => {
  it('renders tabs, supports quick-open Class:line syntax, and minimizes on Escape', async () => {
    const onOpenClass = vi.fn();
    const onMinimize = vi.fn();
    const state = openSourceTab(EMPTY_SOURCE_TABS, { target: 'com.example.DemoResource' });

    render(
      <div class="rab-n">
        <div class="rab-n-topbar" />
        <div class="rab-n-body-row" />
        <SourceDialog
          baseUrl="/jira"
          state={state}
          decompiler="vineflower"
          onDecompiler={() => undefined}
          onSelectTab={() => undefined}
          onCloseTab={() => undefined}
          onCloseAll={() => undefined}
          onUndo={() => undefined}
          onOpenClass={onOpenClass}
          onResolveTab={() => undefined}
          onMinimize={onMinimize}
        />
      </div>,
      document.body,
    );

    const waitUntil = async (fn: () => boolean, ms = 500) => {
      const end = Date.now() + ms;
      while (Date.now() < end && !fn()) await new Promise((r) => setTimeout(r, 15));
      return fn();
    };
    await waitUntil(() => !!document.querySelector('.rab-n-topbar')?.hasAttribute('inert'));
    expect(document.querySelector('[data-testid=source-dialog]')).not.toBeNull();
    expect(document.querySelector('.rab-n-topbar')?.hasAttribute('inert')).toBe(true);

    // Open quick-open input, type Class:42, and submit
    const addBtn = document.querySelector('[data-testid=source-dialog-add]') as HTMLButtonElement;
    addBtn.click();
    await waitUntil(() => !!document.querySelector('[data-testid=source-dialog-quickopen]'));

    const form = document.querySelector('[data-testid=source-dialog-quickopen]') as HTMLFormElement;
    const input = form.querySelector('input') as HTMLInputElement;
    input.value = 'com.example.Other:42';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(onOpenClass).toHaveBeenCalledWith({
      target: 'com.example.Other',
      candidates: ['com.example.Other'],
      focusLine: 42,
    });

    // Escape minimizes the dialog
    await new Promise((r) => setTimeout(r, 20));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(onMinimize).toHaveBeenCalledTimes(1);
  });

  it('keeps only a single roving tabIndex=0 stop across SourceCode links instead of one per reference', () => {
    const src = [
      'package com.example;',
      'import java.util.List;',
      'public class Demo {',
      ...Array.from({ length: 12 }, (_, i) => `  public List<String> m${i}(String a, Integer b) { return null; }`),
      '}',
    ].join('\n');
    render(
      <SourceCode
        source={src}
        className="com.example.Demo"
        refs={['java.util.List', 'java.lang.String', 'java.lang.Integer']}
        onOpenClass={() => undefined}
      />,
      document.body,
    );
    const links = [...document.querySelectorAll<HTMLElement>('[data-class-ref]')];
    expect(links.length).toBeGreaterThan(20);
    const tabStops = links.filter((el) => el.getAttribute('tabindex') === '0');
    expect(tabStops).toHaveLength(1);
    expect(links.filter((el) => el.getAttribute('tabindex') === '-1')).toHaveLength(links.length - 1);
  });
});
