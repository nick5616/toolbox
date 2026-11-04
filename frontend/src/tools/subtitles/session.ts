/**
 * Popping the whole Subtitles tool out opens a new window with an empty
 * store. Before that happens the main window parks the session (source,
 * cues with their undo history, selected track) in module state under its own
 * key; the new tool window restores it once and clears it. A session older
 * than a minute is ignored, so a stale one never resurfaces later.
 */
import { useEffect } from "react";
import { SettingsService } from "@/lib/api";
import { useIsEmbedded } from "@/lib/embed";
import { currentWindow } from "@/lib/windows";
import { useBeforePopOut } from "@/lib/popout";
import type { EditorState } from "./editor";
import { MODULE_ID, useSubtitles } from "./store";

export const SESSION_KEY = `${MODULE_ID}-session`;
export const SESSION_MAX_AGE_MS = 60_000;

interface Session {
  v: 1;
  at: number;
  mediaPath: string | null;
  subPath: string | null;
  editor: EditorState;
  selectedId: string;
  sourceLang: string | null;
  chosen: ReturnType<typeof useSubtitles.getState>["chosen"];
  addVisuals: boolean;
  playheadMs: number;
}

function hasWork(): boolean {
  const s = useSubtitles.getState();
  return s.mediaPath !== null || s.editor.tabs.length > 0;
}

/** Parks the open session (nothing when there isn't one). */
export async function saveSession(now: number = Date.now()): Promise<void> {
  if (!hasWork()) return;
  const s = useSubtitles.getState();
  const session: Session = {
    v: 1,
    at: now,
    mediaPath: s.mediaPath,
    subPath: s.subPath,
    editor: s.editor,
    selectedId: s.selectedId,
    sourceLang: s.sourceLang,
    chosen: s.chosen,
    addVisuals: s.addVisuals,
    playheadMs: s.playheadMs,
  };
  await SettingsService.SetModuleState(SESSION_KEY, JSON.stringify(session));
}

function isEditor(v: unknown): v is EditorState {
  if (typeof v !== "object" || v === null) return false;
  const e = v as { tabs?: unknown; activeId?: unknown };
  return (
    Array.isArray(e.tabs) &&
    typeof e.activeId === "string" &&
    e.tabs.every((t) => typeof t === "object" && t !== null && Array.isArray((t as { history?: { present?: unknown } }).history?.present))
  );
}

/** Restores a parked session into the (empty) store and clears it; true when one was restored. */
export async function restoreSession(now: number = Date.now()): Promise<boolean> {
  let raw = "";
  try {
    raw = await SettingsService.ModuleState(SESSION_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;
  await SettingsService.SetModuleState(SESSION_KEY, "").catch(() => undefined);
  try {
    const s = JSON.parse(raw) as Partial<Session>;
    if (s.v !== 1 || typeof s.at !== "number" || now - s.at > SESSION_MAX_AGE_MS || !isEditor(s.editor)) return false;
    if (hasWork()) return false; // something was handed over meanwhile
    useSubtitles.setState({
      mediaPath: typeof s.mediaPath === "string" ? s.mediaPath : null,
      subPath: typeof s.subPath === "string" ? s.subPath : null,
      editor: s.editor,
      selectedId: typeof s.selectedId === "string" ? s.selectedId : "",
      sourceLang: typeof s.sourceLang === "string" ? s.sourceLang : null,
      chosen: s.chosen ?? null,
      addVisuals: s.addVisuals === true,
      playheadMs: typeof s.playheadMs === "number" ? s.playheadMs : 0,
    });
    return true;
  } catch {
    return false;
  }
}

/** Main window: park before the tool pops out. A new tool window: restore what was parked. */
export function useSessionTransfer(): void {
  const embedded = useIsEmbedded();
  useBeforePopOut(MODULE_ID, () => saveSession());
  useEffect(() => {
    if (embedded || currentWindow().kind !== "tool") return;
    void restoreSession();
  }, [embedded]);
}
