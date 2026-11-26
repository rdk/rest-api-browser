import { useEffect, useRef, useState } from 'preact/hooks';

export type Step = { n: number; dir: number };

/**
 * Coordinates search matches within one response view (`JsonView` or `TextView`):
 * re-searches on needle or row-wrapping changes, steps on Enter/Shift+Enter, and reports `(count, index, needle)` back.
 */
export function useFind(
  needle: string,
  step: Step,
  onFound: (count: number, index: number, forNeedle: string) => void,
  search: (needle: string) => number[],
  rows?: unknown,
) {
  const [state, setState] = useState<{ needle: string; matches: number[]; current: number }>(() => ({
    needle,
    matches: needle ? search(needle) : [],
    current: 0,
  }));
  const searchRef = useRef(search);
  searchRef.current = search;

  const firstRows = useRef(rows);
  const prevNeedle = useRef(needle);
  useEffect(() => {
    const matches = needle ? searchRef.current(needle) : [];
    const needleChanged = prevNeedle.current !== needle;
    prevNeedle.current = needle;
    const rowsChanged = firstRows.current !== rows;
    firstRows.current = rows;
    setState((prev) => ({
      needle,
      matches,
      current: needleChanged ? 0 : rowsChanged ? Math.max(0, Math.min(prev.current, Math.max(0, matches.length - 1))) : prev.current,
    }));
  }, [needle, rows]);

  const seen = useRef(step.n);
  useEffect(() => {
    if (step.n === seen.current) return;
    seen.current = step.n;
    setState((prev) => ({
      ...prev,
      current: prev.matches.length ? (prev.current + step.dir + prev.matches.length) % prev.matches.length : 0,
    }));
  }, [step.n, step.dir]);

  useEffect(() => onFound(state.matches.length, state.current, state.needle), [state, onFound]);
  return { matches: state.matches, current: state.current };
}
