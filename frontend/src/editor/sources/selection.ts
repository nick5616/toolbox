/**
 * The Sources panel's selection (Phase 9 SPEC §14.6), kept here so Auto-fill's
 * "selected sources" option (WP-ES6) can read it. Paths of project sources.
 */
import { create } from "zustand";

interface SourceSelection {
  paths: string[];
  set(paths: string[]): void;
  toggle(path: string): void;
  clear(): void;
}

const NONE: string[] = [];

export const useSourceSelection = create<SourceSelection>((set, get) => ({
  paths: NONE,
  set: (paths) => set({ paths: paths.length ? paths : NONE }),
  toggle: (path) => {
    const cur = get().paths;
    const next = cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path];
    set({ paths: next.length ? next : NONE });
  },
  clear: () => set({ paths: NONE }),
}));

/** The selected source paths (a stable array reference until the selection changes). */
export function useSelectedSources(): readonly string[] {
  return useSourceSelection((s) => s.paths);
}
