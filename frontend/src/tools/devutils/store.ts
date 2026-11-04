/**
 * Every utility's input and options live in one store, so a utility can pop
 * out into its own window and stay live (Phase 11, SPEC §5.7): the main window
 * hosts this store, replicas forward `setValue` to it. Values are JSON.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { create } from "zustand";

export type DevUtilsValues = {
  /** `<util>.<key>` → JSON value. */
  values: Record<string, unknown>;
};

export interface DevUtilsStore extends DevUtilsValues {
  setValue(key: string, value: unknown): void;
}

export const useDevUtils = create<DevUtilsStore>((set) => ({
  values: {},
  setValue: (key, value) => set((s) => ({ values: { ...s.values, [key]: value } })),
}));

/** How long a replica shows its own edit before it trusts the host's value again. */
const LOCAL_MS = 800;

/**
 * `useState` backed by the utilities store (key `<util>.<key>`). A replica
 * shows its own edit at once and drops it when the host's value catches up,
 * so typing never waits for the round trip.
 */
export function useUtilState<T>(util: string, key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const k = `${util}.${key}`;
  const stored = useDevUtils((s) => s.values[k]) as T | undefined;
  const fallback = useRef<{ v: T } | null>(null);
  if (fallback.current === null) fallback.current = { v: typeof initial === "function" ? (initial as () => T)() : initial };
  const [local, setLocal] = useState<{ v: T } | null>(null);

  useEffect(() => {
    if (local === null) return;
    if (JSON.stringify(stored) === JSON.stringify(local.v)) {
      setLocal(null);
      return;
    }
    const t = setTimeout(() => setLocal(null), LOCAL_MS);
    return () => clearTimeout(t);
  }, [stored, local]);

  const value = local ? local.v : stored !== undefined ? stored : fallback.current.v;
  const latest = useRef(value);
  latest.current = value;

  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      const v = typeof next === "function" ? (next as (p: T) => T)(latest.current) : next;
      latest.current = v;
      setLocal({ v });
      useDevUtils.getState().setValue(k, v);
    },
    [k],
  );
  return [value, set];
}

/** Writes a utility's value from outside a utility (hand-offs). */
export function setUtilValue(util: string, key: string, value: unknown): void {
  useDevUtils.getState().setValue(`${util}.${key}`, value);
}
