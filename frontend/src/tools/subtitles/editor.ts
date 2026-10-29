import { commit, cuesKey, newHistory, redo, undo, type CueRow, type History } from "./logic";

/** One editable subtitle track ("Original", "Spanish", …). */
export interface EditorTab {
  id: string;
  label: string;
  /** ISO 639-1 code or "" when unknown. */
  language: string;
  history: History<CueRow[]>;
  /** cuesKey of the rows as last saved or loaded from disk. */
  savedKey: string;
  /** The file this track lives in once it exists on disk (Save passes it back so it is overwritten). */
  savedPath?: string;
}

export interface EditorState {
  tabs: EditorTab[];
  activeId: string;
}

export const EMPTY_EDITOR: EditorState = { tabs: [], activeId: "" };

export type EditorAction =
  | { type: "reset" }
  | { type: "open"; tab: EditorTab }
  | { type: "addTab"; tab: EditorTab }
  | { type: "select"; id: string }
  | { type: "edit"; fn: (rows: CueRow[]) => CueRow[]; key?: string; at?: number }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "saved"; id: string; key: string; path?: string };

export function makeTab(id: string, label: string, language: string, rows: CueRow[], savedPath?: string): EditorTab {
  return { id, label, language, history: newHistory(rows), savedKey: cuesKey(rows), savedPath };
}

export function activeTab(s: EditorState): EditorTab | undefined {
  return s.tabs.find((t) => t.id === s.activeId);
}

export function isDirty(t: EditorTab): boolean {
  return cuesKey(t.history.present) !== t.savedKey;
}

export function anyDirty(s: EditorState): boolean {
  return s.tabs.some(isDirty);
}

function mapActive(s: EditorState, fn: (t: EditorTab) => EditorTab): EditorState {
  return { ...s, tabs: s.tabs.map((t) => (t.id === s.activeId ? fn(t) : t)) };
}

export function editorReducer(s: EditorState, a: EditorAction): EditorState {
  switch (a.type) {
    case "reset":
      return EMPTY_EDITOR;
    case "open":
      return { tabs: [a.tab], activeId: a.tab.id };
    case "addTab": {
      // A second translation into the same language replaces the earlier tab.
      const rest = s.tabs.filter((t) => t.id !== a.tab.id && !(a.tab.language !== "" && t.language === a.tab.language && t !== s.tabs[0]));
      return { tabs: [...rest, a.tab], activeId: a.tab.id };
    }
    case "select":
      return s.tabs.some((t) => t.id === a.id) ? { ...s, activeId: a.id } : s;
    case "edit":
      return mapActive(s, (t) => ({ ...t, history: commit(t.history, a.fn(t.history.present), a.key, a.at) }));
    case "undo":
      return mapActive(s, (t) => ({ ...t, history: undo(t.history) }));
    case "redo":
      return mapActive(s, (t) => ({ ...t, history: redo(t.history) }));
    case "saved":
      return {
        ...s,
        tabs: s.tabs.map((t) => (t.id === a.id ? { ...t, savedKey: a.key, savedPath: a.path ?? t.savedPath } : t)),
      };
  }
}
