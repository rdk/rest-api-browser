import { describe, expect, it } from 'vitest';
import {
  canNavigateSourceBack, canNavigateSourceForward, closeAllSourceTabs, closeSourceTab, EMPTY_SOURCE_TABS,
  minimizeSourceDialog, navigateSourceBack, navigateSourceForward, openSourceTab, recordSourceLocation,
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

  it('resolves canonical class name and merges duplicate tabs preserving uid and focusMethod', () => {
    let s = openSourceTab(EMPTY_SOURCE_TABS, { target: 'com.example.Outer.Inner', candidates: ['com.example.Outer.Inner', 'com.example.Alt'] });
    const firstUid = s.tabs[0].uid;
    s = resolveSourceTab(s, 'com.example.Outer.Inner', 'com.example.Outer$Inner');
    expect(s.tabs[0].uid).toBe(firstUid);
    expect(s.tabs[0].id).toBe('com.example.Outer$Inner');
    expect(s.tabs[0].label).toBe('Outer.Inner');
    expect(s.tabs[0].candidates).toEqual(['com.example.Outer$Inner']);
    expect(s.activeId).toBe('com.example.Outer$Inner');

    s = openSourceTab(s, { target: 'OtherAlias', focusMethod: 'doWork', focusParamCount: 2 });
    s = resolveSourceTab(s, 'OtherAlias', 'com.example.Outer$Inner');
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].uid).toBe(firstUid);
    expect(s.tabs[0].focusMethod).toBe('doWork');
    expect(s.tabs[0].focusParamCount).toBe(2);
    expect(s.activeId).toBe('com.example.Outer$Inner');

    // Subsequent open with speculative dotted target + dollar candidate deduplicates immediately without creating a 2nd tab
    s = openSourceTab(s, {
      target: 'com.example.Outer.Inner',
      candidates: ['com.example.Outer.Inner', 'com.example.Outer$Inner'],
      focusMethod: 'secondWork',
    });
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].id).toBe('com.example.Outer$Inner');
    expect(s.tabs[0].focusMethod).toBe('secondWork');
  });

  it('tracks back and forward navigation history across tabs and in-tab locations', () => {
    let s = openSourceTab(EMPTY_SOURCE_TABS, { target: 'a.Alpha', focusMethod: 'init' });
    expect(canNavigateSourceBack(s)).toBe(false);
    expect(canNavigateSourceForward(s)).toBe(false);

    s = recordSourceLocation(s, { tabId: 'a.Alpha', focusMethod: 'helper', focusLine: 42 });
    s = openSourceTab(s, { target: 'a.Beta', focusLine: 10 });
    expect(s.activeId).toBe('a.Beta');
    expect(canNavigateSourceBack(s)).toBe(true);

    s = navigateSourceBack(s);
    expect(s.activeId).toBe('a.Alpha');
    expect(s.tabs.find((t) => t.id === 'a.Alpha')?.focusLine).toBe(42);
    expect(canNavigateSourceForward(s)).toBe(true);

    s = navigateSourceBack(s);
    expect(s.activeId).toBe('a.Alpha');
    expect(s.tabs.find((t) => t.id === 'a.Alpha')?.focusMethod).toBe('init');
    expect(canNavigateSourceBack(s)).toBe(false);

    s = navigateSourceForward(s);
    expect(s.tabs.find((t) => t.id === 'a.Alpha')?.focusLine).toBe(42);
    s = navigateSourceForward(s);
    expect(s.activeId).toBe('a.Beta');
    expect(canNavigateSourceForward(s)).toBe(false);
  });

  it('preserves navigation history on undo, skips closed tabs, and clears focus when returning to top-of-file entries', () => {
    let s = openSourceTab(EMPTY_SOURCE_TABS, { target: 'a.Alpha' });
    s = recordSourceLocation(s, { tabId: 'a.Alpha', focusMethod: 'work', focusLine: 25 });
    s = openSourceTab(s, { target: 'a.Beta', focusLine: 5 });

    // Close Beta then Undo must preserve Back history to Alpha:25 and Alpha(top)
    s = closeSourceTab(s, 'a.Beta');
    s = undoCloseSourceTabs(s);
    expect(canNavigateSourceBack(s)).toBe(true);

    s = navigateSourceBack(s);
    expect(s.activeId).toBe('a.Alpha');
    expect(s.tabs.find((t) => t.id === 'a.Alpha')?.focusLine).toBe(25);

    // Navigating back to the top-of-file entry clears prior focusLine/focusMethod and bumps focusSeq
    const seqBefore = s.tabs.find((t) => t.id === 'a.Alpha')?.focusSeq ?? 0;
    s = navigateSourceBack(s);
    const alpha = s.tabs.find((t) => t.id === 'a.Alpha');
    expect(alpha?.focusLine).toBeUndefined();
    expect(alpha?.focusMethod).toBeUndefined();
    expect((alpha?.focusSeq ?? 0) > seqBefore).toBe(true);

    // Move forward to Alpha:25 and close Beta: Forward must skip closed Beta
    s = navigateSourceForward(s);
    s = closeSourceTab(s, 'a.Beta');
    expect(canNavigateSourceForward(s)).toBe(false);
  });
});
