/**
 * A clip's gain line (Phase 21 SPEC §B1/§B2). `Clip.Gain` is an EditParam in
 * dB, keys only: "" = 0 dB, a number = the whole clip, `{base, keys}` = a
 * curve in clip-relative ms. These helpers are pure; the volume line in the
 * tracks drives them.
 */
import { interpolateKeys } from "@/viz/edit/params";
import { baseOf, parseEditParam } from "@/viz/edit/schema";
import type { EditParam, Key } from "@/viz/edit/types";

export const GAIN_MIN_DB = -60;
export const GAIN_MAX_DB = 12;
export const MAX_FADE_MS = 10_000;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** The gain param of a clip (0 dB when empty or invalid). */
export function parseGain(raw: string | undefined): EditParam {
  if (!raw) return 0;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return 0;
  }
  return parseEditParam(v, 0, { min: GAIN_MIN_DB, max: GAIN_MAX_DB, allowMods: false }, "gain", []);
}

/** The JSON a clip stores ("" for a flat 0 dB). */
export function serializeGain(p: EditParam): string {
  if (typeof p === "number") return p === 0 ? "" : JSON.stringify(p);
  if (!p.keys?.length) return p.base === 0 ? "" : JSON.stringify(p.base);
  return JSON.stringify({ base: p.base, keys: p.keys });
}

export const gainKeys = (p: EditParam): Key[] => (typeof p === "number" ? [] : (p.keys ?? []));

/** The gain in dB at clip-relative ms. */
export function gainDbAt(p: EditParam, tMs: number): number {
  if (typeof p === "number") return p;
  return p.keys?.length ? interpolateKeys(p.keys, tMs) : p.base;
}

/**
 * The line's vertical mapping: +12 dB at the top, −60 dB at the bottom, linear
 * in dB (0 dB sits a sixth of the way down, −14 dB a bit over a third).
 */
export function dbToFrac(db: number): number {
  return (GAIN_MAX_DB - clamp(db, GAIN_MIN_DB, GAIN_MAX_DB)) / (GAIN_MAX_DB - GAIN_MIN_DB);
}

export function fracToDb(frac: number): number {
  return GAIN_MAX_DB - clamp(frac, 0, 1) * (GAIN_MAX_DB - GAIN_MIN_DB);
}

/** y in px of a gain inside a lane of `heightPx`. */
export const dbToY = (db: number, heightPx: number): number => dbToFrac(db) * heightPx;
/** dB at y px (clamped), rounded to 0.1. */
export const yToDb = (y: number, heightPx: number): number => Math.round(fracToDb(heightPx > 0 ? y / heightPx : 0) * 10) / 10;

/** Sets the whole clip's gain (keys shift by the same amount so the curve keeps its shape). */
export function setGainFlat(p: EditParam, db: number): EditParam {
  const v = clamp(db, GAIN_MIN_DB, GAIN_MAX_DB);
  const keys = gainKeys(p);
  if (!keys.length) return v;
  const shift = v - gainDbAt(p, 0);
  return { base: clamp(baseOf(p) + shift, GAIN_MIN_DB, GAIN_MAX_DB), keys: keys.map((k) => ({ ...k, v: clamp(k.v + shift, GAIN_MIN_DB, GAIN_MAX_DB) })) };
}

/** Adds (or moves) a key at clip-relative t with the value `db`; the first key turns a flat gain into a curve. */
export function setGainKey(p: EditParam, tMs: number, db: number, lenMs: number): EditParam {
  const len = Math.max(0, Math.round(lenMs));
  const t = Math.round(clamp(tMs, 0, len));
  const v = clamp(db, GAIN_MIN_DB, GAIN_MAX_DB);
  const had = gainKeys(p);
  if (!had.length) {
    // The flat level stays on both sides of the new key.
    const flat = baseOf(p);
    const keys: Key[] = [];
    if (t > 0) keys.push({ t: 0, v: flat, ease: "linear" });
    keys.push({ t, v, ease: "linear" });
    if (t < len) keys.push({ t: len, v: flat, ease: "linear" });
    return { base: flat, keys };
  }
  const keys = had.filter((k) => Math.abs(k.t - t) > 0.5);
  keys.push({ t, v, ease: "linear" });
  keys.sort((a, b) => a.t - b.t);
  return { base: baseOf(p), keys: keys.slice(0, 64) };
}

/** Removes the key at t; the last key removed leaves a flat gain at its value. */
export function removeGainKey(p: EditParam, tMs: number): EditParam {
  const keys = gainKeys(p);
  const rest = keys.filter((k) => Math.abs(k.t - tMs) > 0.5);
  if (rest.length === keys.length) return p;
  if (rest.length <= 1) return rest[0] ? rest[0].v : baseOf(p);
  return { base: baseOf(p), keys: rest };
}

/** Moves one key (by index) to a new time and level. */
export function moveGainKey(p: EditParam, index: number, tMs: number, db: number, lenMs: number): EditParam {
  const keys = gainKeys(p).slice();
  const k = keys[index];
  if (!k) return p;
  keys[index] = { ...k, t: Math.round(clamp(tMs, 0, Math.max(0, lenMs))), v: clamp(db, GAIN_MIN_DB, GAIN_MAX_DB) };
  keys.sort((a, b) => a.t - b.t);
  return { base: baseOf(p), keys };
}

/** Index of the key within `tolMs` of t, or −1. */
export function nearestKey(p: EditParam, tMs: number, tolMs: number): number {
  let best = -1;
  let bestD = tolMs;
  gainKeys(p).forEach((k, i) => {
    const d = Math.abs(k.t - tMs);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

export interface Pt {
  x: number;
  y: number;
}

/** The gain line of a clip as points (px) in a lane of `heightPx`: flat across without keys, else through the keys and held flat beyond the first and last. */
export function gainPolyline(p: EditParam, lenMs: number, pps: number, heightPx: number): Pt[] {
  const w = (Math.max(0, lenMs) * pps) / 1000;
  const keys = gainKeys(p);
  if (!keys.length) {
    const y = dbToY(baseOf(p), heightPx);
    return [
      { x: 0, y },
      { x: w, y },
    ];
  }
  const pts = keys.map((k) => ({ x: (k.t * pps) / 1000, y: dbToY(k.v, heightPx) }));
  const first = pts[0] as Pt;
  const last = pts[pts.length - 1] as Pt;
  if (first.x > 0) pts.unshift({ x: 0, y: first.y });
  if (last.x < w) pts.push({ x: w, y: last.y });
  return pts;
}

/** A fade handle drag: ms from the clip edge, clamped to 0..10 s and so the two fades never cross. */
export function clampFade(wantMs: number, lenMs: number, otherFadeMs: number): number {
  return Math.round(clamp(wantMs, 0, Math.max(0, Math.min(MAX_FADE_MS, lenMs - otherFadeMs))));
}
