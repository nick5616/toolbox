import type { LyricLine, LyricWord } from "@/lib/api";

/** One editable lyric line. Word times travel with the line. */
export interface Row {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  words: LyricWord[];
}

let counter = 0;
export function newRowId(): string {
  counter += 1;
  return `l${counter}`;
}

export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** The file name without its extension. */
export function stem(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(0, i) : b;
}

// ---- Conversion ----

export function toRows(lines: LyricLine[] | null | undefined): Row[] {
  return (lines ?? []).map((l) => ({
    id: newRowId(),
    startMs: l.startMs,
    endMs: Math.max(l.startMs, l.endMs),
    text: l.text,
    words: (l.words ?? []).map((w) => ({ ...w })),
  }));
}

/** Lines for a job: blank lines are dropped. */
export function toLines(rows: Row[]): LyricLine[] {
  return rows
    .filter((r) => r.text.trim() !== "")
    .map((r) => ({
      startMs: Math.round(r.startMs),
      endMs: Math.round(Math.max(r.startMs, r.endMs)),
      text: r.text.trim(),
      words: r.words.map((w) => ({ startMs: Math.round(w.startMs), endMs: Math.round(w.endMs), text: w.text })),
    }));
}

export function rowsKey(rows: Row[]): string {
  return rows.map((r) => `${r.startMs}:${r.endMs}:${r.text}`).join("|");
}

// ---- Words ----

/** Spreads a line's words over [startMs, endMs] by character share. */
export function spreadWords(text: string, startMs: number, endMs: number): LyricWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const total = tokens.reduce((n, t) => n + [...t].length, 0);
  const span = Math.max(0, endMs - startMs);
  const out: LyricWord[] = [];
  let used = 0;
  tokens.forEach((t, i) => {
    const from = startMs + Math.round((span * used) / total);
    used += [...t].length;
    const to = i === tokens.length - 1 ? endMs : startMs + Math.round((span * used) / total);
    out.push({ startMs: from, endMs: to, text: t });
  });
  return out;
}

function shiftWords(words: LyricWord[], delta: number): LyricWord[] {
  return words.map((w) => ({ ...w, startMs: w.startMs + delta, endMs: w.endMs + delta }));
}

// ---- Editing ----

function mapRow(rows: Row[], id: string, fn: (r: Row) => Row): Row[] {
  let changed = false;
  const next = rows.map((r) => {
    if (r.id !== id) return r;
    const n = fn(r);
    if (n !== r) changed = true;
    return n;
  });
  return changed ? next : rows;
}

/** Moves a line so it starts at startMs; its end and word times move with it. */
export function setLineStart(rows: Row[], id: string, startMs: number): Row[] {
  const to = Math.max(0, Math.round(startMs));
  return mapRow(rows, id, (r) => {
    const delta = to - r.startMs;
    if (delta === 0) return r;
    return { ...r, startMs: to, endMs: r.endMs + delta, words: shiftWords(r.words, delta) };
  });
}

/** Nudges a line by deltaMs (negative = earlier). Never before 0. */
export function nudgeLine(rows: Row[], id: string, deltaMs: number): Row[] {
  const row = rows.find((r) => r.id === id);
  if (!row) return rows;
  return setLineStart(rows, id, row.startMs + deltaMs);
}

/** Shifts every line (and word) by deltaMs; the first line can't go below 0. */
export function shiftAll(rows: Row[], deltaMs: number): Row[] {
  if (rows.length === 0 || deltaMs === 0) return rows;
  const first = Math.min(...rows.map((r) => r.startMs));
  const d = Math.max(deltaMs, -first);
  if (d === 0) return rows;
  return rows.map((r) => ({ ...r, startMs: r.startMs + d, endMs: r.endMs + d, words: shiftWords(r.words, d) }));
}

/** Changes a line's text; its words are re-spread over the line's time. */
export function setLineText(rows: Row[], id: string, text: string): Row[] {
  return mapRow(rows, id, (r) => (r.text === text ? r : { ...r, text, words: spreadWords(text, r.startMs, r.endMs) }));
}

/** Inserts an empty line after index (-1 = at the top), between its neighbours in time. */
export function insertAfter(rows: Row[], index: number, atMs?: number): { rows: Row[]; id: string } {
  const prev = rows[index];
  const next = rows[index + 1];
  let start = atMs ?? prev?.endMs ?? 0;
  if (prev) start = Math.max(start, prev.startMs);
  if (next) start = Math.min(start, next.startMs);
  start = Math.max(0, Math.round(start));
  const end = next ? Math.max(start, Math.min(start + 2000, next.startMs)) : start + 2000;
  const row: Row = { id: newRowId(), startMs: start, endMs: end, text: "", words: [] };
  const copy = rows.slice();
  copy.splice(index + 1, 0, row);
  return { rows: copy, id: row.id };
}

export function deleteRow(rows: Row[], id: string): Row[] {
  return rows.filter((r) => r.id !== id);
}

// ---- Tap to sync ----

export interface TapResult {
  rows: Row[];
  /** The next line to stamp. */
  next: number;
  /** True once the last line has been stamped. */
  done: boolean;
}

function clipWords(words: LyricWord[], endMs: number): LyricWord[] {
  return words.map((w) => ({ ...w, startMs: Math.min(w.startMs, endMs), endMs: Math.min(w.endMs, endMs) }));
}

/**
 * Stamps line `index` to start at `ms` (its end and words move along). Later
 * lines that would now start earlier are pushed to keep the order, and the
 * previous line is cut off at `ms` if it ran past it.
 */
export function tapStamp(rows: Row[], index: number, ms: number): TapResult {
  const target = rows[index];
  if (!target) return { rows, next: index, done: true };
  const at = Math.max(0, Math.round(ms));
  let out = setLineStart(rows, target.id, at);
  const prev = out[index - 1];
  if (prev && prev.endMs > at) {
    const end = Math.max(prev.startMs, at);
    out = out.map((r, i) => (i === index - 1 ? { ...r, endMs: end, words: clipWords(r.words, end) } : r));
  }
  for (let j = index + 1; j < out.length; j++) {
    const before = out[j - 1];
    const row = out[j];
    if (!before || !row || row.startMs >= before.startMs) break;
    const d = before.startMs - row.startMs;
    out[j] = { ...row, startMs: row.startMs + d, endMs: row.endMs + d, words: shiftWords(row.words, d) };
  }
  const next = index + 1;
  return { rows: out, next, done: next >= out.length };
}

/** Backspace in tap mode: back one line (never below the first). */
export function tapBack(index: number): number {
  return Math.max(0, index - 1);
}

// ---- Playback position ----

/** The line the playhead is inside (start <= ms < end), or -1. */
export function lineAt(rows: Row[], ms: number): number {
  let found = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    if (r.startMs <= ms && ms < r.endMs) found = i;
  }
  return found;
}

/** The latest line that has started at ms (the one a sheet highlights), or -1. */
export function latestStarted(rows: Row[], ms: number): number {
  let found = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r && r.startMs <= ms) found = i;
  }
  return found;
}

/**
 * How much of a line is "sung" at ms, 0..1 of its characters, from the word
 * times (linear over the line when it has none). Holds between words.
 */
export function karaokeProgress(row: Row, ms: number): number {
  if (row.words.length === 0) {
    const span = row.endMs - row.startMs;
    if (span <= 0) return ms >= row.startMs ? 1 : 0;
    return Math.min(1, Math.max(0, (ms - row.startMs) / span));
  }
  const total = row.words.reduce((n, w) => n + [...w.text].length, 0);
  if (total === 0) return 0;
  let done = 0;
  for (const w of row.words) {
    const len = [...w.text].length;
    if (ms >= w.endMs) {
      done += len;
      continue;
    }
    if (ms > w.startMs && w.endMs > w.startMs) done += (len * (ms - w.startMs)) / (w.endMs - w.startMs);
    break;
  }
  return Math.min(1, done / total);
}

// ---- Checks ----

export interface DocIssues {
  /** Index of the first line that starts before the one above it, or -1. */
  firstOutOfOrder: number;
  blank: number;
  /** A message that blocks rendering, or "". */
  blocker: string;
}

export function documentIssues(rows: Row[]): DocIssues {
  let firstOutOfOrder = -1;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (a && b && b.startMs < a.startMs) {
      firstOutOfOrder = i;
      break;
    }
  }
  const used = rows.filter((r) => r.text.trim() !== "");
  let blocker = "";
  if (used.length === 0) blocker = "Add at least one line of lyrics.";
  else if (used.length > 2000) blocker = "There are too many lines (the limit is 2,000).";
  else if (firstOutOfOrder >= 0) blocker = `Line ${firstOutOfOrder + 1} starts before the line above it. Fix its time.`;
  return { firstOutOfOrder, blank: rows.length - used.length, blocker };
}

/** Lines whose timing looks off (very short, very long or impossibly fast). */
export function suspectIds(rows: Row[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    const span = r.endMs - r.startMs;
    const chars = [...r.text.trim()].length;
    if (chars === 0) continue;
    if (span < 300 || span > 15000 || (chars / Math.max(span, 1)) * 1000 > 25) out.add(r.id);
  }
  return out;
}

/** matched below this shows the "couldn't follow the song" warning. */
export const LOW_MATCH = 0.4;
/** matched below this asks the user to look over the timings. */
export const OKAY_MATCH = 0.7;

// ---- History (undo/redo) ----

export const HISTORY_LIMIT = 100;
export const COALESCE_MS = 800;

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  lastKey?: string | undefined;
  lastAt: number;
}

export function newHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], lastAt: 0 };
}

/** Applies a change; changes with the same key inside COALESCE_MS share one undo step. */
export function commit<T>(h: History<T>, next: T, key?: string, at: number = Date.now()): History<T> {
  if (next === h.present) return h;
  const coalesce = key !== undefined && h.lastKey === key && at - h.lastAt < COALESCE_MS && h.past.length > 0;
  const past = coalesce ? h.past : [...h.past, h.present].slice(-HISTORY_LIMIT);
  return { past, present: next, future: [], lastKey: key, lastAt: at };
}

export function undo<T>(h: History<T>): History<T> {
  const prev = h.past[h.past.length - 1];
  if (prev === undefined) return h;
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future], lastAt: 0 };
}

export function redo<T>(h: History<T>): History<T> {
  const next = h.future[0];
  if (next === undefined) return h;
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: h.future.slice(1), lastAt: 0 };
}

export type EditorAction =
  | { type: "reset"; rows: Row[] }
  | { type: "edit"; fn: (rows: Row[]) => Row[]; key?: string; at?: number }
  | { type: "undo" }
  | { type: "redo" };

export function editorReducer(h: History<Row[]>, a: EditorAction): History<Row[]> {
  switch (a.type) {
    case "reset":
      return newHistory(a.rows);
    case "edit":
      return commit(h, a.fn(h.present), a.key, a.at);
    case "undo":
      return undo(h);
    case "redo":
      return redo(h);
  }
}

// ---- Misc ----

/** Title/Artist from a file's tags (any key case). */
export function tagValue(tags: { [k: string]: string | undefined } | null | undefined, key: string): string {
  if (!tags) return "";
  for (const [k, v] of Object.entries(tags)) if (k.toLowerCase() === key && v) return v.trim();
  return "";
}

export function parseMs(text: string): number | null {
  const s = text.trim();
  if (!s) return null;
  if (/^[+-]?\d+$/.test(s)) return Number(s);
  return null;
}
