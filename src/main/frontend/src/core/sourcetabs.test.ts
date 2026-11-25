import { describe, expect, it } from 'vitest';
import {
  closeAllSourceTabs, closeSourceTab, EMPTY_SOURCE_TABS, minimizeSourceDialog, openSourceTab,
  resolveSourceTab, selectSourceTab, showSourceDialog, undoCloseSourceTabs,
} from './sourcetabs';

describe('sourcetabs', () => {
  it('opens, deduplicates, minimizes without losing tabs, and restores', () => {
    let s = openSourceTab(EMPTY_SOURCE_TABS, { target: 'com.example.Foo', opKey: 'op1', focusMethod: 'bar' });
    expect(s.open).toBe(true);
    expect(s.tabs.map((t) => t.id)).toEqual(['com.example.Foo']);
    expect(s.activeId).toBe('com.example.Foo');
    expect(s.tabs[0].focusMethod).toBe('bar');

    s = openSourceTab(s, { target: 'com.example.Bar' });
    expect(s.tabs.map((t) => t.id)).toEqual(['com.example.Foo', 'com.example.Bar']);
    expect(s.activeId).toBe('com.example.Bar');

    // deduplicates existing tab
    s = openSourceTab(s, { target: 'com.example.Foo' });
    expect(s.tabs).toHaveLength(2);
    expect(s.activeId).toBe('com.example.Foo');

    // minimizing hides the dialog while keeping every tab intact
    s = minimizeSourceDialog(s);
    expect(s.open).toBe(false);
    expect(s.tabs).toHaveLength(2);
    expect(s.activeId).toBe('com.example.Foo');

    // showing brings the dialog back with the same tabs
    s = showSourceDialog(s);
    expect(s.open).toBe(true);
    expect(s.tabs).toHaveLength(2);
  });

  it('closes individual tabs and undoes in order at the original position', () => {
    let s = openSourceTab(EMPTY_SOURCE_TABS, { target: 'a.One' });
    s = openSourceTab(s, { target: 'a.Two' });
    s = openSourceTab(s, { target: 'a.Three' });
    s = selectSourceTab(s, 'a.Two');

    s = closeSourceTab(s, 'a.Two');
    expect(s.tabs.map((t) => t.id)).toEqual(['a.One', 'a.Three']);
    expect(s.activeId).toBe('a.Three');
    expect(s.undoStack).toHaveLength(1);

    s = undoCloseSourceTabs(s);
    expect(s.tabs.map((t) => t.id)).toEqual(['a.One', 'a.Two', 'a.Three']);
    expect(s.activeId).toBe('a.Two');
    expect(s.undoStack).toHaveLength(0);
  });

  it('closes all tabs and restores all of them in a single undo', () => {
    let s = openSourceTab(EMPTY_SOURCE_TABS, { target: 'a.One' });
    s = openSourceTab(s, { target: 'a.Two' });
    s = openSourceTab(s, { target: 'a.Three' });
    s = selectSourceTab(s, 'a.Two');

    s = closeAllSourceTabs(s);
    expect(s.tabs).toHaveLength(0);
    expect(s.activeId).toBe('');
    expect(s.undoStack).toHaveLength(1);
    expect(s.undoStack[0].label).toBe('3 tabs');

    s = undoCloseSourceTabs(s);
    expect(s.open).toBe(true);
    expect(s.tabs.map((t) => t.id)).toEqual(['a.One', 'a.Two', 'a.Three']);
    expect(s.activeId).toBe('a.Two');
  });

  it('resolves canonical class name and merges duplicate tabs', () => {
    let s = openSourceTab(EMPTY_SOURCE_TABS, { target: 'com.example.Outer.Inner', candidates: ['com.example.Outer.Inner'] });
    s = resolveSourceTab(s, 'com.example.Outer.Inner', 'com.example.Outer$Inner');
    expect(s.tabs[0].id).toBe('com.example.Outer$Inner');
    expect(s.tabs[0].label).toBe('Outer.Inner');
    expect(s.activeId).toBe('com.example.Outer$Inner');

    s = openSourceTab(s, { target: 'OtherAlias' });
    s = resolveSourceTab(s, 'OtherAlias', 'com.example.Outer$Inner');
    expect(s.tabs).toHaveLength(1);
    expect(s.activeId).toBe('com.example.Outer$Inner');
  });
});
