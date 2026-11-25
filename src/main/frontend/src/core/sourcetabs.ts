import { classLabel } from './javarefs';

export interface SourceTab {
  id: string;
  label: string;
  candidates: string[];
  fromBundle?: number;
  opKey?: string;
  focusMethod?: string;
  focusParamCount?: number;
  focusSeq?: number;
}

export interface ClosedTabEntry {
  tab: SourceTab;
  index: number;
}

export interface ClosedSnapshot {
  label: string;
  entries: ClosedTabEntry[];
  previousActiveId: string;
}

export interface SourceTabsState {
  open: boolean;
  tabs: SourceTab[];
  activeId: string;
  undoStack: ClosedSnapshot[];
}

export const EMPTY_SOURCE_TABS: SourceTabsState = {
  open: false,
  tabs: [],
  activeId: '',
  undoStack: [],
};

const MAX_UNDO = 30;
let seq = 1;

export interface OpenTabRequest {
  target: string;
  candidates?: string[];
  fromBundle?: number;
  opKey?: string;
  focusMethod?: string;
  focusParamCount?: number;
}

/** Opens (or activates) a tab for a Java class and shows the dialog. */
export function openSourceTab(state: SourceTabsState, req: OpenTabRequest): SourceTabsState {
  const target = req.target.trim();
  if (!target) return state;
  const cands = req.candidates && req.candidates.length ? req.candidates : [target];
  const existing = state.tabs.find((t) => t.id === target || t.candidates.includes(target));
  if (existing) {
    const updated = req.focusMethod
      ? state.tabs.map((t) => (t.id === existing.id
        ? { ...t, focusMethod: req.focusMethod, focusParamCount: req.focusParamCount, focusSeq: ++seq }
        : t))
      : state.tabs;
    return { ...state, open: true, tabs: updated, activeId: existing.id };
  }
  const tab: SourceTab = {
    id: target,
    label: classLabel(target),
    candidates: cands,
    fromBundle: req.fromBundle,
    opKey: req.opKey,
    focusMethod: req.focusMethod,
    focusParamCount: req.focusParamCount,
    focusSeq: req.focusMethod ? ++seq : undefined,
  };
  return {
    ...state,
    open: true,
    tabs: [...state.tabs, tab],
    activeId: tab.id,
  };
}

export function selectSourceTab(state: SourceTabsState, id: string): SourceTabsState {
  if (!state.tabs.some((t) => t.id === id)) return state;
  return { ...state, activeId: id };
}

/** Closes one tab and records it on the undo stack so it can be restored at its original position. */
export function closeSourceTab(state: SourceTabsState, id: string): SourceTabsState {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return state;
  const removed = state.tabs[idx];
  const nextTabs = state.tabs.filter((t) => t.id !== id);
  const nextActive = state.activeId === id
    ? (nextTabs[Math.min(idx, nextTabs.length - 1)]?.id ?? '')
    : state.activeId;
  const snap: ClosedSnapshot = {
    label: removed.label,
    entries: [{ tab: removed, index: idx }],
    previousActiveId: state.activeId,
  };
  return {
    ...state,
    tabs: nextTabs,
    activeId: nextActive,
    undoStack: [...state.undoStack.slice(-(MAX_UNDO - 1)), snap],
  };
}

/** Closes every open tab in one step so a single Undo restores all of them. */
export function closeAllSourceTabs(state: SourceTabsState): SourceTabsState {
  if (!state.tabs.length) return state;
  const snap: ClosedSnapshot = {
    label: state.tabs.length === 1 ? state.tabs[0].label : `${state.tabs.length} tabs`,
    entries: state.tabs.map((tab, index) => ({ tab, index })),
    previousActiveId: state.activeId,
  };
  return {
    ...state,
    tabs: [],
    activeId: '',
    undoStack: [...state.undoStack.slice(-(MAX_UNDO - 1)), snap],
  };
}

/** Restores the most recently closed tab (or batch of tabs) and opens the dialog. */
export function undoCloseSourceTabs(state: SourceTabsState): SourceTabsState {
  if (!state.undoStack.length) return state;
  const snap = state.undoStack[state.undoStack.length - 1];
  const nextUndo = state.undoStack.slice(0, -1);
  const nextTabs = [...state.tabs];
  const sorted = [...snap.entries].sort((a, b) => a.index - b.index);
  let lastRestoredId = '';
  for (const { tab, index } of sorted) {
    if (!nextTabs.some((t) => t.id === tab.id)) {
      const at = Math.max(0, Math.min(index, nextTabs.length));
      nextTabs.splice(at, 0, tab);
    }
    lastRestoredId = tab.id;
  }
  const activeId = nextTabs.some((t) => t.id === snap.previousActiveId)
    ? snap.previousActiveId
    : (lastRestoredId || state.activeId);
  return {
    open: true,
    tabs: nextTabs,
    activeId,
    undoStack: nextUndo,
  };
}

/** Updates a tab's canonical FQCN once the server resolves it (deduplicating if another tab already holds that class). */
export function resolveSourceTab(state: SourceTabsState, tabId: string, resolvedClass: string): SourceTabsState {
  if (!resolvedClass || tabId === resolvedClass) return state;
  const existing = state.tabs.find((t) => t.id === resolvedClass && t.id !== tabId);
  if (existing) {
    const nextTabs = state.tabs.filter((t) => t.id !== tabId);
    return {
      ...state,
      tabs: nextTabs,
      activeId: state.activeId === tabId ? existing.id : state.activeId,
    };
  }
  const nextTabs = state.tabs.map((t) => (t.id === tabId ? { ...t, id: resolvedClass, label: classLabel(resolvedClass) } : t));
  return {
    ...state,
    tabs: nextTabs,
    activeId: state.activeId === tabId ? resolvedClass : state.activeId,
  };
}

/** Minimizes (hides) the dialog while preserving all open tabs and undo history. */
export function minimizeSourceDialog(state: SourceTabsState): SourceTabsState {
  return state.open ? { ...state, open: false } : state;
}

/** Shows the dialog without modifying tabs. */
export function showSourceDialog(state: SourceTabsState): SourceTabsState {
  return state.open ? state : { ...state, open: true };
}
