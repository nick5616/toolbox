import { MidiRange, type MidiOptions } from "@/lib/api";

export const MODULE_ID = "audio-to-midi";

/** Mirrors Go's DefaultOptions() (modules/midi). */
export const DEFAULT_MIDI_OPTIONS: MidiOptions = {
  sensitivity: 0.5,
  noteFloor: 0.3,
  minNoteMs: 127.7,
  range: MidiRange.RangeFull,
  melodiaTrick: true,
};

function inRange(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

/** `sanitize` for useModuleOptions: keeps only valid, in-range fields over defaults. */
export function sanitizeMidiOptions(raw: unknown, defaults: MidiOptions): MidiOptions {
  const out: MidiOptions = { ...defaults };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (inRange(r.sensitivity, 0.1, 0.9)) out.sensitivity = r.sensitivity;
  if (inRange(r.noteFloor, 0.1, 0.6)) out.noteFloor = r.noteFloor;
  if (inRange(r.minNoteMs, 30, 500)) out.minNoteMs = r.minNoteMs;
  if (typeof r.range === "string" && (Object.values(MidiRange) as string[]).includes(r.range) && r.range !== "") {
    out.range = r.range as MidiRange;
  }
  if (typeof r.melodiaTrick === "boolean") out.melodiaTrick = r.melodiaTrick;
  return out;
}

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** MIDI note number to name, C4 = 60 (36 -> "C2"). */
export function noteName(midi: number): string {
  const n = Math.round(midi);
  return `${NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

/** "C2–G5" for a [low, high] pair; empty when invalid. */
export function formatPitchRange(range: readonly number[] | null | undefined): string {
  if (!range || range.length < 2) return "";
  const [lo, hi] = range;
  if (typeof lo !== "number" || typeof hi !== "number") return "";
  return `${noteName(lo)}–${noteName(hi)}`;
}

export interface MidiParsed {
  notes: number;
  pitchRange: number[];
  durationSec: number;
}

/** Parses a midi job's resultJson; null when missing or malformed. */
export function parseMidiResult(json: string | null | undefined): MidiParsed | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== "object" || v === null) return null;
    const r = v as Record<string, unknown>;
    if (typeof r.notes !== "number") return null;
    const pr = Array.isArray(r.pitchRange) ? (r.pitchRange as unknown[]).filter((x): x is number => typeof x === "number") : [];
    return { notes: r.notes, pitchRange: pr, durationSec: typeof r.durationSec === "number" ? r.durationSec : 0 };
  } catch {
    return null;
  }
}
