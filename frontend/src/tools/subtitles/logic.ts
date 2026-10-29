import type { Cue } from "@/lib/api";

/** A cue with a stable id for list keys and undo. Times are timeline ms. */
export interface CueRow {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
}

export const MAX_LINE_CHARS = 42;
export const MAX_CPS = 20;
export const MAX_CUE_CHARS = 500;
export const MAX_CUES = 20000;
export const MAX_LINES = 2;
export const MIN_CUE_MS = 100;
export const HISTORY_LIMIT = 100;
/** Edits to the same field within this window share one undo step. */
export const COALESCE_MS = 1000;

let seq = 0;
export function newCueId(): string {
  seq += 1;
  return `cue-${seq}`;
}

export function toRows(cues: readonly Cue[] | null | undefined): CueRow[] {
  return (cues ?? []).map((c) => ({ id: newCueId(), startMs: c.startMs, endMs: c.endMs, text: c.text }));
}

export function toCues(rows: readonly CueRow[]): Cue[] {
  return rows.map((r) => ({ startMs: r.startMs, endMs: r.endMs, text: r.text }));
}

/** A cheap fingerprint used to tell whether the rows differ from what was saved. */
export function cuesKey(rows: readonly CueRow[]): string {
  let out = String(rows.length);
  for (const r of rows) out += `|${r.startMs},${r.endMs},${r.text}`;
  return out;
}

// ---- Validation and warnings ----

export interface CueIssues {
  /** Problems the backend would reject. */
  errors: string[];
  /** Readability hints. */
  warnings: string[];
}

export function lineCount(text: string): number {
  return text.split("\n").length;
}

export function charsPerSecond(row: CueRow): number {
  const secs = (row.endMs - row.startMs) / 1000;
  if (secs <= 0) return Infinity;
  return text_len(row.text.replace(/\n/g, "")) / secs;
}

function text_len(s: string): number {
  return Array.from(s).length;
}

/** Issues for the cue at index `i` of `rows`. */
export function cueIssues(rows: readonly CueRow[], i: number, maxLine: number = MAX_LINE_CHARS): CueIssues {
  const r = rows[i];
  const out: CueIssues = { errors: [], warnings: [] };
  if (!r) return out;
  if (r.endMs <= r.startMs) out.errors.push("Must end after it starts");
  const prev = rows[i - 1];
  if (prev && r.startMs < prev.startMs) out.errors.push("Starts before the previous subtitle");
  if (r.text.trim() === "") out.errors.push("Text is empty");
  if (text_len(r.text) > MAX_CUE_CHARS) out.errors.push(`Longer than ${MAX_CUE_CHARS} characters`);
  const lines = r.text.split("\n");
  if (lines.length > MAX_LINES) out.warnings.push(`${lines.length} lines (2 reads best)`);
  if (lines.some((l) => text_len(l) > maxLine)) out.warnings.push(`A line is over ${maxLine} characters`);
  if (r.endMs > r.startMs && charsPerSecond(r) > MAX_CPS) out.warnings.push(`Over ${MAX_CPS} characters per second`);
  return out;
}

export interface DocumentIssues {
  /** Count of cues with at least one error. */
  errorCount: number;
  warningCount: number;
  /** The first error message, "Subtitle N: …". */
  firstError: string | null;
  tooMany: boolean;
}

export function documentIssues(rows: readonly CueRow[], maxLine: number = MAX_LINE_CHARS): DocumentIssues {
  let errorCount = 0;
  let warningCount = 0;
  let firstError: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const { errors, warnings } = cueIssues(rows, i, maxLine);
    if (errors.length > 0) {
      errorCount++;
      firstError ??= `Subtitle ${i + 1}: ${errors[0]}`;
    }
    if (warnings.length > 0) warningCount++;
  }
  return { errorCount, warningCount, firstError, tooMany: rows.length > MAX_CUES };
}

// ---- Lookup ----

/** Index of the cue showing at `ms` (the last one starting at or before it), or -1. */
export function activeCueIndex(rows: readonly CueRow[], ms: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = rows[mid];
    if (!r) break;
    if (r.startMs <= ms) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  // With overlaps the nearest earlier start may already be over; look back a little.
  for (let k = found; k >= 0 && k > found - 4; k--) {
    const r = rows[k];
    if (r && r.startMs <= ms && ms < r.endMs) return k;
  }
  return -1;
}

// ---- Text helpers ----

/**
 * Joins the text into one line, or two balanced lines when it is longer than
 * `maxLine` (the break goes at the space nearest the middle, preferring one
 * after punctuation).
 */
export function wrapText(text: string, maxLine: number = MAX_LINE_CHARS): string {
  const flat = text.replace(/\s*\n\s*/g, " ").replace(/ {2,}/g, " ").trim();
  if (text_len(flat) <= maxLine) return flat;
  const mid = flat.length / 2;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 1; i < flat.length - 1; i++) {
    if (flat[i] !== " ") continue;
    const afterPunct = /[.,;:!?…。、，？！]/.test(flat[i - 1] ?? "");
    const score = Math.abs(i - mid) - (afterPunct ? 4 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0) return flat;
  return `${flat.slice(0, best)}\n${flat.slice(best + 1)}`;
}

/** The caret to split at when none is known: the space nearest the middle, else the middle. */
export function defaultSplitCaret(text: string): number {
  const mid = Math.floor(text.length / 2);
  let best = -1;
  for (let d = 0; d <= mid; d++) {
    for (const i of [mid - d, mid + d]) {
      const c = text[i];
      if (i > 0 && i < text.length && (c === " " || c === "\n")) {
        best = i;
        break;
      }
    }
    if (best >= 0) break;
  }
  return best >= 0 ? best : mid;
}

// ---- Edits (pure; every function returns a new array) ----

export function updateCue(rows: readonly CueRow[], id: string, patch: Partial<Omit<CueRow, "id">>): CueRow[] {
  return rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
}

/**
 * Splits cue `index` at text position `caret`. The time is the playhead when it
 * falls inside the cue, else proportional to the caret. Returns null when
 * either half would be empty.
 */
export function splitCue(rows: readonly CueRow[], index: number, caret: number, playheadMs?: number): CueRow[] | null {
  const r = rows[index];
  if (!r) return null;
  const left = r.text.slice(0, caret).trim();
  const right = r.text.slice(caret).trim();
  if (left === "" || right === "") return null;
  const span = r.endMs - r.startMs;
  let at: number;
  if (playheadMs !== undefined && playheadMs > r.startMs + MIN_CUE_MS && playheadMs < r.endMs - MIN_CUE_MS) at = Math.round(playheadMs);
  else at = r.startMs + Math.round((span * caret) / Math.max(1, r.text.length));
  at = Math.min(r.endMs - 1, Math.max(r.startMs + 1, at));
  const a: CueRow = { ...r, endMs: at, text: left };
  const b: CueRow = { id: newCueId(), startMs: at, endMs: r.endMs, text: right };
  return [...rows.slice(0, index), a, b, ...rows.slice(index + 1)];
}

/** Merges cue `index` with the next one. Returns null on the last cue. */
export function mergeWithNext(rows: readonly CueRow[], index: number, maxLine: number = MAX_LINE_CHARS): CueRow[] | null {
  const a = rows[index];
  const b = rows[index + 1];
  if (!a || !b) return null;
  const merged: CueRow = {
    ...a,
    startMs: Math.min(a.startMs, b.startMs),
    endMs: Math.max(a.endMs, b.endMs),
    text: wrapText(`${a.text} ${b.text}`, maxLine),
  };
  return [...rows.slice(0, index), merged, ...rows.slice(index + 2)];
}

/** Inserts an empty cue after `index` (or first, when index is -1) in the gap, 2 s long when there is room. */
export function insertAfter(rows: readonly CueRow[], index: number, durationMs: number = 2000): { rows: CueRow[]; id: string } {
  const prev = rows[index];
  const next = rows[index + 1];
  const start = prev ? prev.endMs : 0;
  let end = start + durationMs;
  if (next && next.startMs > start) end = Math.min(end, Math.max(start + MIN_CUE_MS, next.startMs));
  const row: CueRow = { id: newCueId(), startMs: start, endMs: end, text: "" };
  return { rows: [...rows.slice(0, index + 1), row, ...rows.slice(index + 1)], id: row.id };
}

export function deleteCue(rows: readonly CueRow[], id: string): CueRow[] {
  return rows.filter((r) => r.id !== id);
}

/** Shifts every cue by `deltaMs` (negative = earlier). Times never go below 0. */
export function shiftAll(rows: readonly CueRow[], deltaMs: number): CueRow[] {
  return rows.map((r) => {
    const startMs = Math.max(0, r.startMs + deltaMs);
    const endMs = Math.max(startMs + 1, r.endMs + deltaMs);
    return { ...r, startMs, endMs };
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function countMatches(rows: readonly CueRow[], find: string, matchCase: boolean): number {
  if (find === "") return 0;
  const re = new RegExp(escapeRe(find), matchCase ? "g" : "gi");
  let n = 0;
  for (const r of rows) n += r.text.match(re)?.length ?? 0;
  return n;
}

export function findReplace(
  rows: readonly CueRow[],
  find: string,
  replacement: string,
  matchCase: boolean,
): { rows: CueRow[]; count: number } {
  if (find === "") return { rows: [...rows], count: 0 };
  const re = new RegExp(escapeRe(find), matchCase ? "g" : "gi");
  let count = 0;
  const out = rows.map((r) => {
    const text = r.text.replace(re, () => {
      count++;
      return replacement;
    });
    return text === r.text ? r : { ...r, text };
  });
  return { rows: out, count };
}

// ---- History ----

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** Key of the last coalescable edit, with its time. */
  lastKey?: string;
  lastAt: number;
}

export function newHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], lastAt: 0 };
}

/** Applies a change; consecutive changes with the same key inside COALESCE_MS share one undo step. */
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

// ---- Misc ----

const SUBTITLE_EXT = /\.(srt|vtt)$/i;
export function isSubtitlePath(path: string): boolean {
  return SUBTITLE_EXT.test(path);
}

export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** Markers for the timeline, one per cue (capped so a 20,000-cue file stays responsive). */
export const MAX_MARKERS = 4000;
