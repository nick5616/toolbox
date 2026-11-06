/**
 * Reopen where you left off (Phase 11 follow-up): the session (song, lyrics
 * text, the sheet's lines with their timings and edits) is kept in module state
 * under `lyric-video.session`, apart from the look/render options, which the
 * view already remembers under the module id. On open without a handoff the
 * session comes back if the song still exists; a missing song drops it. The
 * undo history is not kept, and the listening never starts by itself.
 */
import { FilesService, SettingsService, type LyricWord } from "@/lib/api";
import { useUI } from "@/state/ui";
import { newRowId, type Row } from "./logic";
import { LYRIC_VIDEO_ID, useLyricVideo } from "./store";

export const SESSION_KEY = "lyric-video.session";
/** core.MaxModuleStateBytes is 64 KB; stay below it. */
export const MAX_SESSION_BYTES = 56 * 1024;

export interface Session {
  songPath: string;
  meta: { title: string; artist: string };
  text: string;
  lyricsPath: string;
  rows: Row[];
  matched: number | null;
  noLyrics: boolean;
  hasInstrumental: boolean;
}

const num = (v: unknown, f = 0) => (typeof v === "number" && Number.isFinite(v) ? v : f);
const str = (v: unknown, f = "") => (typeof v === "string" ? v : f);

function sanitizeRows(raw: unknown): Row[] {
  if (!Array.isArray(raw)) return [];
  const rows: Row[] = [];
  for (const r of raw) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.text !== "string") continue;
    rows.push({ id: o.id, startMs: num(o.startMs), endMs: num(o.endMs), text: o.text, words: Array.isArray(o.words) ? (o.words as LyricWord[]) : [] });
  }
  return rows;
}

export function sanitizeSession(raw: unknown): Session | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.songPath !== "string" || !o.songPath) return null;
  const m = (typeof o.meta === "object" && o.meta !== null ? o.meta : {}) as Record<string, unknown>;
  return {
    songPath: o.songPath,
    meta: { title: str(m.title), artist: str(m.artist) },
    text: str(o.text),
    lyricsPath: str(o.lyricsPath),
    rows: sanitizeRows(o.rows),
    matched: typeof o.matched === "number" ? o.matched : null,
    noLyrics: o.noLyrics === true,
    hasInstrumental: o.hasInstrumental === true,
  };
}

/** The JSON to keep, within the cap: too big drops word timings, then the lines. Null when there is no song. */
export function serializeSession(s: Session | null): string | null {
  if (!s || !s.songPath) return null;
  let json = JSON.stringify(s);
  if (json.length <= MAX_SESSION_BYTES) return json;
  json = JSON.stringify({ ...s, rows: s.rows.map((r) => ({ ...r, words: [] })) });
  if (json.length <= MAX_SESSION_BYTES) return json;
  return JSON.stringify({ ...s, rows: [], text: s.text.length > 20_000 ? "" : s.text });
}

let taken = false;
/** Restores once per page: React's StrictMode runs effects twice in dev. */
export function takeRestore(): boolean {
  if (taken) return false;
  taken = true;
  return true;
}
export function resetRestoreForTest(): void {
  taken = false;
}

async function readSession(): Promise<Session | null> {
  try {
    const raw = await SettingsService.ModuleState(SESSION_KEY);
    return raw ? sanitizeSession(JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/**
 * Brings the last session back unless a song is already open or a handoff is
 * waiting. Returns true when the store was filled.
 */
export async function restoreSession(): Promise<boolean> {
  const rec = await readSession();
  if (!rec) return false;
  const free = () => useLyricVideo.getState().songPath === null && useUI.getState().handoff?.moduleId !== LYRIC_VIDEO_ID;
  if (!free()) return false;
  let exists = false;
  try {
    const info = (await FilesService.Stat([rec.songPath]))?.[0];
    exists = !!info && info.exists && !info.isDir;
  } catch {
    exists = false;
  }
  if (!free()) return false;
  if (!exists) {
    SettingsService.SetModuleState(SESSION_KEY, "").catch(() => undefined);
    return false;
  }
  const s = useLyricVideo.getState();
  s.applySong(rec.songPath);
  s.setMeta(rec.meta);
  s.setText(rec.text);
  s.setLyricsPath(rec.lyricsPath);
  // Fresh ids: the counter starts over with the page, so saved ids could collide with new lines.
  s.resetSheet(rec.rows.map((r) => ({ ...r, id: newRowId() })));
  s.setMatched(rec.matched);
  s.setNoLyrics(rec.noLyrics);
  s.setHasInstrumental(rec.hasInstrumental);
  return true;
}
