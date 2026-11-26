import { classLabel } from '../lib/java-source/javatypes';

export interface SourceTab {
  /** Immutable client identity used as UI key so resolving/renaming `id` never remounts panels. */
  uid: string;
  id: string;
  label: string;
  candidates: string[];
  fromBundle?: number;
  opKey?: string;
  focusMethod?: string;
  focusParamCount?: number;
  focusLine?: number;
  focusSeq?: number;
}

export interface SourceNavEntry {
  tabId: string;
  focusMethod?: string;
  focusParamCount?: number;
  focusLine?: number;
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
  navHistory?: SourceNavEntry[];
  navIndex?: number;
}

export const EMPTY_SOURCE_TABS: SourceTabsState = {
  open: false,
  tabs: [],
  activeId: '',
  undoStack: [],
  navHistory: [],
  navIndex: -1,
};

const MAX_UNDO = 30;
const MAX_NAV = 60;
let seq = 1;
let uidSeq = 1;

export interface OpenTabRequest {
  target: string;
  candidates?: string[];
  fromBundle?: number;
  opKey?: string;
  focusMethod?: string;
  focusParamCount?: number;
  focusLine?: number;
}

function pushNavEntry(state: SourceTabsState, entry: SourceNavEntry): { navHistory: SourceNavEntry[]; navIndex: number } {
  const hist = state.navHistory ?? [];
  const idx = state.navIndex ?? (hist.length - 1);
  const base = idx >= 0 && idx < hist.length ? hist.slice(0, idx + 1) : hist;
  const last = base[base.length - 1];
  if (
    last
    && last.tabId === entry.tabId
    && last.focusMethod === entry.focusMethod
    && last.focusParamCount === entry.focusParamCount
    && last.focusLine === entry.focusLine
  ) {
    return { navHistory: base, navIndex: base.length - 1 };
  }
  const next = [...base, entry].slice(-MAX_NAV);
  return { navHistory: next, navIndex: next.length - 1 };
}

/** Opens (or activates) a tab for a Java class and shows the dialog. */
export function openSourceTab(state: SourceTabsState, req: OpenTabRequest): SourceTabsState {
  const target = req.target.trim();
  if (!target) return state;
  const cands = req.candidates && req.candidates.length ? req.candidates : [target];
  const existing = state.tabs.find((t) => cands.some((c) => t.id === c || t.candidates.includes(c)));
  const hasFocus = !!(req.focusMethod || (req.focusLine !== undefined && req.focusLine > 0));
  if (existing) {
    const updated = hasFocus
      ? state.tabs.map((t) => (t.id === existing.id
        ? {
          ...t,
          focusMethod: req.focusMethod,
          focusParamCount: req.focusParamCount,
          focusLine: req.focusLine,
          focusSeq: ++seq,
        }
        : t))
      : state.tabs;
    const nav = pushNavEntry(state, {
      tabId: existing.id,
      focusMethod: hasFocus ? req.focusMethod : existing.focusMethod,
      focusParamCount: hasFocus ? req.focusParamCount : existing.focusParamCount,
      focusLine: hasFocus ? req.focusLine : existing.focusLine,
    });
    return { ...state, open: true, tabs: updated, activeId: existing.id, ...nav };
  }
  const tab: SourceTab = {
    uid: `tab-${uidSeq++}`,
    id: target,
    label: classLabel(target),
    candidates: cands,
    fromBundle: req.fromBundle,
    opKey: req.opKey,
    focusMethod: req.focusMethod,
    focusParamCount: req.focusParamCount,
    focusLine: req.focusLine,
    focusSeq: hasFocus ? ++seq : undefined,
  };
  const nav = pushNavEntry(state, {
    tabId: tab.id,
    focusMethod: req.focusMethod,
    focusParamCount: req.focusParamCount,
    focusLine: req.focusLine,
  });
  return {
    ...state,
    open: true,
    tabs: [...state.tabs, tab],
    activeId: tab.id,
    ...nav,
  };
}

export function selectSourceTab(state: SourceTabsState, id: string): SourceTabsState {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return state;
  const nav = pushNavEntry(state, {
    tabId: id,
    focusMethod: tab.focusMethod,
    focusParamCount: tab.focusParamCount,
    focusLine: tab.focusLine,
  });
  return { ...state, activeId: id, ...nav };
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
    ...state,
    open: true,
    tabs: nextTabs,
    activeId,
    undoStack: nextUndo,
  };
}

/**
 * Updates a tab's canonical FQCN once the server resolves it, narrowing speculative candidates to `[resolvedClass]`
 * and preserving focus method/sequence when merging into an already-open tab.
 */
export function resolveSourceTab(state: SourceTabsState, tabId: string, resolvedClass: string): SourceTabsState {
  if (!resolvedClass) return state;
  const current = state.tabs.find((t) => t.id === tabId);
  if (!current) return state;
  if (tabId === resolvedClass) {
    if (current.candidates.length === 1 && current.candidates[0] === resolvedClass) return state;
    return {
      ...state,
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, candidates: [resolvedClass] } : t)),
    };
  }
  const existing = state.tabs.find((t) => t.id === resolvedClass && t.id !== tabId);
  const renameHist = (hist?: SourceNavEntry[]) =>
    hist ? hist.map((e) => (e.tabId === tabId ? { ...e, tabId: resolvedClass } : e)) : undefined;
  if (existing) {
    const takeFocus = !!(current.focusMethod || current.focusLine) && (current.focusSeq ?? 0) >= (existing.focusSeq ?? 0);
    const nextTabs = state.tabs
      .filter((t) => t.id !== tabId)
      .map((t) => (t.id === existing.id
        ? {
          ...t,
          candidates: [resolvedClass],
          ...(takeFocus ? {
            focusMethod: current.focusMethod,
            focusParamCount: current.focusParamCount,
            focusLine: current.focusLine,
            focusSeq: current.focusSeq,
          } : {}),
        }
        : t));
    return {
      ...state,
      tabs: nextTabs,
      activeId: state.activeId === tabId ? existing.id : state.activeId,
      navHistory: renameHist(state.navHistory),
    };
  }
  const nextTabs = state.tabs.map((t) => (t.id === tabId
    ? { ...t, id: resolvedClass, label: classLabel(resolvedClass), candidates: [resolvedClass] }
    : t));
  return {
    ...state,
    tabs: nextTabs,
    activeId: state.activeId === tabId ? resolvedClass : state.activeId,
    navHistory: renameHist(state.navHistory),
  };
}

/** Records an in-tab location jump (e.g. clicking an outline method or line) in the back/forward history. */
export function recordSourceLocation(state: SourceTabsState, entry: SourceNavEntry): SourceTabsState {
  if (!state.tabs.some((t) => t.id === entry.tabId)) return state;
  const nav = pushNavEntry(state, entry);
  return { ...state, ...nav };
}

function findNavTarget(state: SourceTabsState, dir: -1 | 1): number {
  const hist = state.navHistory ?? [];
  const start = state.navIndex ?? (hist.length - 1);
  for (let i = start + dir; i >= 0 && i < hist.length; i += dir) {
    const entry = hist[i];
    if (state.tabs.some((t) => t.id === entry.tabId || t.candidates.includes(entry.tabId))) {
      return i;
    }
  }
  return -1;
}

export function canNavigateSourceBack(state: SourceTabsState): boolean {
  return findNavTarget(state, -1) >= 0;
}

export function canNavigateSourceForward(state: SourceTabsState): boolean {
  return findNavTarget(state, 1) >= 0;
}

function applyNavIndex(state: SourceTabsState, nextIdx: number): SourceTabsState {
  const hist = state.navHistory ?? [];
  if (nextIdx < 0 || nextIdx >= hist.length) return state;
  const entry = hist[nextIdx];
  const existing = state.tabs.find((t) => t.id === entry.tabId || t.candidates.includes(entry.tabId));
  if (!existing) return { ...state, navIndex: nextIdx };
  const nextTabs = state.tabs.map((t) => (t.id === existing.id
    ? {
      ...t,
      focusMethod: entry.focusMethod,
      focusParamCount: entry.focusParamCount,
      focusLine: entry.focusLine,
      focusSeq: ++seq,
    }
    : t));
  return {
    ...state,
    open: true,
    tabs: nextTabs,
    activeId: existing.id,
    navIndex: nextIdx,
  };
}

export function navigateSourceBack(state: SourceTabsState): SourceTabsState {
  const nextIdx = findNavTarget(state, -1);
  return nextIdx >= 0 ? applyNavIndex(state, nextIdx) : state;
}

export function navigateSourceForward(state: SourceTabsState): SourceTabsState {
  const nextIdx = findNavTarget(state, 1);
  return nextIdx >= 0 ? applyNavIndex(state, nextIdx) : state;
}

/** Minimizes (hides) the dialog while preserving all open tabs and undo history. */
export function minimizeSourceDialog(state: SourceTabsState): SourceTabsState {
  return state.open ? { ...state, open: false } : state;
}

/** Shows the dialog without modifying tabs. */
export function showSourceDialog(state: SourceTabsState): SourceTabsState {
  return state.open ? state : { ...state, open: true };
}
