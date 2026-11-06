import { create } from "zustand";

// The Graph | List choice of the Runs tab, remembered like the editor's.

export type RunViewMode = "graph" | "list";
export const RUN_MODE_KEY = "toolbox.pipelines.runViewMode";

/** The remembered choice; Graph until the user picks List. */
export function loadRunMode(): RunViewMode {
  try {
    return localStorage.getItem(RUN_MODE_KEY) === "list" ? "list" : "graph";
  } catch {
    return "graph";
  }
}

interface ModeState {
  /** null = not chosen in this session: read the remembered value. */
  mode: RunViewMode | null;
  setMode: (m: RunViewMode) => void;
}

export const useRunModeStore = create<ModeState>((set) => ({
  mode: null,
  setMode: (m) => {
    try {
      localStorage.setItem(RUN_MODE_KEY, m);
    } catch {
      // not remembered; fine
    }
    set({ mode: m });
  },
}));

export function useRunMode(): [RunViewMode, (m: RunViewMode) => void] {
  const mode = useRunModeStore((s) => s.mode);
  const setMode = useRunModeStore((s) => s.setMode);
  return [mode ?? loadRunMode(), setMode];
}
