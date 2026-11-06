/**
 * Undo/redo for a design (SPEC.md §8.3, §9.4): the host owns it and passes
 * `show` and `set` to the VisualDesigner. 100 steps. Edits that arrive in a
 * quick burst (a slider drag) merge into one step.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { isEditableTarget } from "@/lib/shortcuts";
import type { Show } from "@/viz/types";

export const HISTORY_LIMIT = 100;
/** Edits closer together than this merge into one undo step. */
export const COALESCE_MS = 400;

interface State {
  past: Show[];
  present: Show;
  future: Show[];
}

export interface ShowHistory {
  show: Show;
  /** Records an edit (becomes the new present). */
  set(next: Show): void;
  /** Replaces the design and forgets the history (a new file, a restored design). */
  reset(next: Show): void;
  /** Ends the current burst so the next edit is its own step. */
  checkpoint(): void;
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
}

export interface ShowHistoryOptions {
  /** Merge window in ms (0 turns merging off, used by tests). */
  coalesceMs?: number;
}

export function useShowHistory(initial: Show, opts: ShowHistoryOptions = {}): ShowHistory {
  const coalesceMs = opts.coalesceMs ?? COALESCE_MS;
  const [state, setState] = useState<State>({ past: [], present: initial, future: [] });
  const lastEdit = useRef(0);

  const set = useCallback(
    (next: Show) => {
      const now = Date.now();
      const merge = coalesceMs > 0 && now - lastEdit.current < coalesceMs;
      lastEdit.current = now;
      setState((s) => {
        if (next === s.present) return s;
        if (merge && s.past.length > 0) return { past: s.past, present: next, future: [] };
        const past = [...s.past, s.present];
        return { past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past, present: next, future: [] };
      });
    },
    [coalesceMs],
  );

  const reset = useCallback((next: Show) => {
    lastEdit.current = 0;
    setState({ past: [], present: next, future: [] });
  }, []);

  const checkpoint = useCallback(() => {
    lastEdit.current = 0;
  }, []);

  const undo = useCallback(() => {
    lastEdit.current = 0;
    setState((s) => {
      const prev = s.past[s.past.length - 1];
      return prev ? { past: s.past.slice(0, -1), present: prev, future: [s.present, ...s.future] } : s;
    });
  }, []);

  const redo = useCallback(() => {
    lastEdit.current = 0;
    setState((s) => {
      const next = s.future[0];
      return next ? { past: [...s.past, s.present], present: next, future: s.future.slice(1) } : s;
    });
  }, []);

  return { show: state.present, set, reset, checkpoint, undo, redo, canUndo: state.past.length > 0, canRedo: state.future.length > 0 };
}

/**
 * Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (also Ctrl+Y) for a history. Text fields keep
 * their own native undo.
 */
export function useUndoKeys(history: Pick<ShowHistory, "undo" | "redo">, enabled = true): void {
  const ref = useRef(history);
  ref.current = history;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        ref.current.undo();
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        ref.current.redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
