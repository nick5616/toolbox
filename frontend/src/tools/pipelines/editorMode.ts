import { create } from "zustand";

// The List | Graph choice of the pipeline editor, shared by the editor and the
// Pipelines page (which hides the pipeline list in Graph mode to give the canvas the full width).

export type EditorMode = "list" | "graph";
export const MODE_KEY = "toolbox.pipelines.editorMode";

/** The remembered choice; Graph until the user picks List. */
export function loadMode(): EditorMode {
  try {
    return localStorage.getItem(MODE_KEY) === "list" ? "list" : "graph";
  } catch {
    return "graph";
  }
}

interface ModeState {
  /** null = not chosen in this session: read the remembered value. */
  mode: EditorMode | null;
  setMode: (m: EditorMode) => void;
}

export const useEditorModeStore = create<ModeState>((set) => ({
  mode: null,
  setMode: (m) => {
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // not remembered; fine
    }
    set({ mode: m });
  },
}));

export function useEditorMode(): [EditorMode, (m: EditorMode) => void] {
  const mode = useEditorModeStore((s) => s.mode);
  const setMode = useEditorModeStore((s) => s.setMode);
  return [mode ?? loadMode(), setMode];
}
