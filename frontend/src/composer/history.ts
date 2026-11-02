import { useCallback, useRef, useState } from "react";

// Undo/redo for the composition (SPEC.md Part B §B5.5): 200 steps; edits that
// arrive within 400 ms of each other (a slider drag, a nudge) merge into one
// step. The same behaviour as the Visualizer designer's useShowHistory, as a
// pure state machine plus a hook.

export const HISTORY_LIMIT = 200;
export const COALESCE_MS = 400;

export interface HistoryState<T> {
  past: T[];
  present: T;
  future: T[];
}

export function initHistory<T>(present: T): HistoryState<T> {
  return { past: [], present, future: [] };
}

/**
 * Records an edit. merge = the previous edit was recent enough that this one
 * belongs to the same step (ignored when there is nothing to merge into).
 */
export function pushEdit<T>(s: HistoryState<T>, next: T, merge: boolean, limit = HISTORY_LIMIT): HistoryState<T> {
  if (next === s.present) return s;
  if (merge && s.past.length > 0) return { past: s.past, present: next, future: [] };
  const past = [...s.past, s.present];
  return { past: past.length > limit ? past.slice(past.length - limit) : past, present: next, future: [] };
}

export function undoState<T>(s: HistoryState<T>): HistoryState<T> {
  const prev = s.past[s.past.length - 1];
  return prev === undefined ? s : { past: s.past.slice(0, -1), present: prev, future: [s.present, ...s.future] };
}

export function redoState<T>(s: HistoryState<T>): HistoryState<T> {
  const next = s.future[0];
  return next === undefined ? s : { past: [...s.past, s.present], present: next, future: s.future.slice(1) };
}

export interface History<T> {
  value: T;
  /** Records an edit (becomes the new present). */
  set(next: T): void;
  /** Replaces the document and forgets the history (open another composition). */
  reset(next: T): void;
  /** Ends the current burst so the next edit is its own step. */
  checkpoint(): void;
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
}

export interface HistoryOptions {
  /** Merge window in ms (0 turns merging off). */
  coalesceMs?: number;
  limit?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export function useHistory<T>(initial: T, opts: HistoryOptions = {}): History<T> {
  const coalesceMs = opts.coalesceMs ?? COALESCE_MS;
  const limit = opts.limit ?? HISTORY_LIMIT;
  const nowRef = useRef(opts.now ?? Date.now);
  nowRef.current = opts.now ?? Date.now;
  const [state, setState] = useState<HistoryState<T>>(() => initHistory(initial));
  const lastEdit = useRef<number | null>(null);

  const set = useCallback(
    (next: T) => {
      const now = nowRef.current();
      const merge = coalesceMs > 0 && lastEdit.current !== null && now - lastEdit.current < coalesceMs;
      lastEdit.current = now;
      setState((s) => pushEdit(s, next, merge, limit));
    },
    [coalesceMs, limit],
  );
  const reset = useCallback((next: T) => {
    lastEdit.current = null;
    setState(initHistory(next));
  }, []);
  const checkpoint = useCallback(() => {
    lastEdit.current = null;
  }, []);
  const undo = useCallback(() => {
    lastEdit.current = null;
    setState(undoState);
  }, []);
  const redo = useCallback(() => {
    lastEdit.current = null;
    setState(redoState);
  }, []);

  return { value: state.present, set, reset, checkpoint, undo, redo, canUndo: state.past.length > 0, canRedo: state.future.length > 0 };
}
