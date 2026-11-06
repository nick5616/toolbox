/**
 * Popping the whole Subtitles tool out opens a new window with an empty
 * store. Before that happens the main window parks the session (source,
 * cues with their undo history, selected track) in module state under its own
 * key; the new tool window restores it once and clears it. A session older
 * than a minute is ignored, so a stale one never resurfaces later.
 */
import { useEffect } from "react";
import { FilesService, SettingsService } from "@/lib/api";
import { useIsEmbedded } from "@/lib/embed";
import { useUI } from "@/state/ui";
import { getWorkspace } from "@/workspace";
import { currentWindow } from "@/lib/windows";
import { useBeforePopOut } from "@/lib/popout";
import { makeTab, type EditorState, type EditorTab } from "./editor";
import type { CueRow } from "./logic";
import { MODULE_ID, NO_MEDIA, useSubtitles } from "./store";

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

// ---- the last session, kept across restarts -------------------------------

export const LAST_SESSION_KEY = `${MODULE_ID}-last`;
/** Above this (JSON length) the session isn't kept: very long documents just start empty next time. */
export const MAX_LAST_SESSION_BYTES = 1024 * 1024;
export const LAST_SAVE_DEBOUNCE_MS = 1200;

interface LastTab {
  id: string;
  label: string;
  language: string;
  rows: CueRow[];
  savedKey: string;
  savedPath?: string;
}

/** What a restart brings back: the source, the cues as edited (no undo history), selection and playhead. Style prefs have their own record. */
interface LastSession {
  v: 1;
  mediaPath: string | null;
  subPath: string | null;
  tabs: LastTab[];
  activeId: string;
  selectedId: string;
  sourceLang: string | null;
  chosen: ReturnType<typeof useSubtitles.getState>["chosen"];
  addVisuals: boolean;
  playheadMs: number;
}

function toLastSession(): LastSession {
  const s = useSubtitles.getState();
  return {
    v: 1,
    mediaPath: s.mediaPath,
    subPath: s.subPath,
    tabs: s.editor.tabs.map((t) => ({ id: t.id, label: t.label, language: t.language, rows: t.history.present, savedKey: t.savedKey, savedPath: t.savedPath })),
    activeId: s.editor.activeId,
    selectedId: s.selectedId,
    sourceLang: s.sourceLang,
    chosen: s.chosen,
    addVisuals: s.addVisuals,
    playheadMs: s.playheadMs,
  };
}

/** Writes the open session as the one to come back to; clears the record when nothing is open or it's too big. */
export async function saveLastSession(): Promise<void> {
  let json = "";
  if (hasWork()) {
    json = JSON.stringify(toLastSession());
    if (json.length > MAX_LAST_SESSION_BYTES) json = "";
  }
  await SettingsService.SetModuleState(LAST_SESSION_KEY, json).catch(() => undefined);
}

function isLastSession(v: unknown): v is LastSession {
  if (typeof v !== "object" || v === null) return false;
  const l = v as Partial<LastSession>;
  return (
    l.v === 1 &&
    Array.isArray(l.tabs) &&
    l.tabs.every((t) => typeof t === "object" && t !== null && typeof t.id === "string" && Array.isArray(t.rows) && typeof t.savedKey === "string") &&
    typeof l.activeId === "string"
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = (await FilesService.Stat([path]))?.[0];
    return !!info && info.exists && !info.isDir;
  } catch {
    return false;
  }
}

function handoffPending(): boolean {
  return useUI.getState().handoff?.moduleId === MODULE_ID;
}

/**
 * Brings the last session back into the empty store when its file still
 * exists; otherwise starts empty and drops the stale record. A handoff (or
 * anything already open) always wins and is left alone.
 */
export async function restoreLastSession(): Promise<boolean> {
  if (hasWork() || handoffPending()) return false;
  let raw = "";
  try {
    raw = await SettingsService.ModuleState(LAST_SESSION_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;
  let l: LastSession | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    l = isLastSession(parsed) ? parsed : null;
  } catch {
    l = null;
  }
  const mediaPath = l && typeof l.mediaPath === "string" && l.mediaPath ? l.mediaPath : null;
  const source = l ? (mediaPath ?? (typeof l.subPath === "string" ? l.subPath : "")) : "";
  if (!l || !source || !(await fileExists(source))) {
    if (!hasWork()) await SettingsService.SetModuleState(LAST_SESSION_KEY, "").catch(() => undefined);
    return false;
  }
  if (hasWork() || handoffPending()) return false; // something arrived while we looked
  const tabs: EditorTab[] = l.tabs.map((t) => ({ ...makeTab(t.id, t.label, t.language, t.rows, t.savedPath), savedKey: t.savedKey }));
  const activeId = l.activeId;
  useSubtitles.setState({
    mediaPath,
    subPath: typeof l.subPath === "string" ? l.subPath : null,
    editor: { tabs, activeId: tabs.some((t) => t.id === activeId) ? activeId : (tabs[0]?.id ?? "") },
    selectedId: typeof l.selectedId === "string" ? l.selectedId : "",
    sourceLang: typeof l.sourceLang === "string" ? l.sourceLang : null,
    chosen: l.chosen ?? null,
    addVisuals: l.addVisuals === true,
    playheadMs: typeof l.playheadMs === "number" ? l.playheadMs : 0,
    media: mediaPath ? { ...NO_MEDIA, status: "loading" } : NO_MEDIA,
  });
  return true;
}

let lastRestore: Promise<boolean> | null = null;

/** Test hook: forget that this page already tried to restore. */
export function resetLastSessionForTest(): void {
  lastRestore = null;
}

/** The main window restores once per page (StrictMode-safe) and keeps the record current. Replicas do neither. */
function useLastSession(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || getWorkspace(MODULE_ID)?.isReplica()) return;
    lastRestore ??= restoreLastSession();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = useSubtitles.subscribe((s, prev) => {
      if (
        s.mediaPath === prev.mediaPath &&
        s.subPath === prev.subPath &&
        s.editor === prev.editor &&
        s.selectedId === prev.selectedId &&
        s.sourceLang === prev.sourceLang &&
        s.chosen === prev.chosen &&
        s.addVisuals === prev.addVisuals &&
        s.playheadMs === prev.playheadMs
      )
        return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void (lastRestore ?? Promise.resolve(false)).then(() => saveLastSession());
      }, LAST_SAVE_DEBOUNCE_MS);
    });
    return () => {
      unsub();
      clearTimeout(timer);
    };
  }, [enabled]);
}

/** Main window: park before the tool pops out and keep the last session. A new tool window: restore what was parked. */
export function useSessionTransfer(): void {
  const embedded = useIsEmbedded();
  useBeforePopOut(MODULE_ID, () => saveSession());
  useLastSession(!embedded && currentWindow().kind === "main");
  useEffect(() => {
    if (embedded || currentWindow().kind !== "tool") return;
    void restoreSession();
  }, [embedded]);
}
