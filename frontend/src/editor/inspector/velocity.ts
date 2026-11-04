/**
 * Velocity presets (Part B SPEC §23.8): speed keys for one clip. Pure.
 *
 * Assumptions:
 * - The speed param is an integrated playback rate (source ms per timeline ms):
 *   2 plays the source twice as fast, 0 holds a frame. The ramps below are
 *   written for that, so a fast start followed by a slow dip lands on the beat.
 * - Key times are clip-relative timeline ms, like every other param key; markers
 *   come in timeline ms. The clip's length on the timeline never changes.
 * - Values stay inside SPEED_MIN..SPEED_MAX and the key list stays short (≤ 6),
 *   with strictly increasing times inside [0, clip length].
 * - A fast section consumes more source than the clip is long: the source needs
 *   room after the clip's in-point.
 */
import { MAX_KEYS, SPEED_MAX, SPEED_MIN } from "@/viz/edit/schema";
import type { EditParam, Key, Marker } from "@/viz/edit/types";

export const VELOCITY_PRESETS = [
  { id: "ramp-into-beat", label: "Ramp into the beat" },
  { id: "slow-on-drop", label: "Slow on the drop" },
  { id: "fast-to-slow", label: "Fast to slow" },
  { id: "freeze-on-beat", label: "Freeze on the beat" },
] as const;
export type VelocityPresetId = (typeof VELOCITY_PRESETS)[number]["id"];

export interface VelocitySpan {
  startMs: number;
  endMs: number;
}

/** Ramp-in speed, the slow point and the exit speed of "Ramp into the beat". */
export const RAMP_FAST = 2;
export const RAMP_SLOW = 0.4;
export const RAMP_EXIT = 1.5;
export const RAMP_EXIT_MS = 450;
/** Shortest clip a preset applies to. */
export const MIN_VELOCITY_CLIP_MS = 400;
/** Beats this close to the clip's start or end are ignored (no room for a ramp). */
const EDGE_MS = 120;
/** Fallback beat length when there is no next beat. */
const DEFAULT_BEAT_MS = 500;

const clampSpeed = (v: number): number => Math.min(SPEED_MAX, Math.max(SPEED_MIN, v));

function lengthOf(clip: VelocitySpan): number {
  return Math.round(clip.endMs - clip.startMs);
}

/** Markers of the lanes inside the clip, clip-relative, sorted. `edge` keeps them clear of the ends. */
function relative(markers: readonly Marker[], lanes: readonly string[], clip: VelocitySpan, edge: number): number[] {
  const len = lengthOf(clip);
  return markers
    .filter((m) => lanes.includes(m.lane))
    .map((m) => Math.round(m.ms - clip.startMs))
    .filter((t) => t >= edge && t <= len - edge)
    .sort((a, b) => a - b);
}

/** The value of `ts` nearest `target`. */
const nearest = (ts: readonly number[], target: number): number | undefined =>
  ts.reduce<number | undefined>((best, t) => (best === undefined || Math.abs(t - target) < Math.abs(best - target) ? t : best), undefined);

/** Sorted keys with strictly increasing times inside [0, len]: early ones clamp to 0 (a later key at the same time wins), keys past the end are dropped. */
function tidy(keys: Key[], len: number): Key[] {
  const out: Key[] = [];
  for (const k of [...keys].sort((a, b) => a.t - b.t)) {
    if (k.t > len) continue;
    const t = Math.max(0, Math.round(k.t));
    const key: Key = { t, v: Math.round(clampSpeed(k.v) * 1000) / 1000, ease: k.ease };
    const last = out[out.length - 1];
    if (last && last.t === t) out[out.length - 1] = key;
    else out.push(key);
  }
  return out.slice(0, MAX_KEYS);
}

const param = (keys: Key[], len: number): EditParam => ({ base: 1, keys: tidy(keys, len) });

/** The beat a ramp aims at: the kick (else beat) nearest the clip's middle, clear of the ends. */
export function rampTarget(markers: readonly Marker[], clip: VelocitySpan): number | null {
  const len = lengthOf(clip);
  const kicks = relative(markers, ["kick"], clip, EDGE_MS);
  const pool = kicks.length ? kicks : relative(markers, ["beat", "downbeat"], clip, EDGE_MS);
  return nearest(pool, len / 2) ?? null;
}

/** 2× → 0.4× on the beat → 1.5× (eases between the keys). */
export function rampIntoBeat(markers: readonly Marker[], clip: VelocitySpan): EditParam | null {
  const len = lengthOf(clip);
  if (len < MIN_VELOCITY_CLIP_MS) return null;
  const b = rampTarget(markers, clip);
  if (b === null) return null;
  return param(
    [
      { t: 0, v: RAMP_FAST, ease: "ease" },
      { t: b, v: RAMP_SLOW, ease: "ease" },
      { t: b + RAMP_EXIT_MS, v: RAMP_EXIT, ease: "ease" },
    ],
    len,
  );
}

/** Normal speed, easing down to 0.3× on the drop, holding it, then back to normal. */
export function slowOnDrop(markers: readonly Marker[], clip: VelocitySpan): EditParam | null {
  const len = lengthOf(clip);
  if (len < MIN_VELOCITY_CLIP_MS) return null;
  const d = nearest(relative(markers, ["drop"], clip, 0), len / 2);
  if (d === undefined) return null;
  return param(
    [
      { t: 0, v: 1, ease: "ease" },
      { t: d - 250, v: 1, ease: "ease" },
      { t: d, v: 0.3, ease: "ease" },
      { t: d + 800, v: 0.3, ease: "ease" },
      { t: d + 1400, v: 1, ease: "ease" },
    ],
    len,
  );
}

/** Starts at 3× and settles to 0.4× by the end. */
export function fastToSlow(_markers: readonly Marker[], clip: VelocitySpan): EditParam | null {
  const len = lengthOf(clip);
  if (len < MIN_VELOCITY_CLIP_MS) return null;
  return param(
    [
      { t: 0, v: 3, ease: "ease" },
      { t: len, v: 0.4, ease: "ease" },
    ],
    len,
  );
}

/** Speed 0 held from the beat nearest the middle for one beat, then normal. */
export function freezeOnBeat(markers: readonly Marker[], clip: VelocitySpan): EditParam | null {
  const len = lengthOf(clip);
  if (len < MIN_VELOCITY_CLIP_MS) return null;
  const beats = relative(markers, ["beat"], clip, 0);
  const b = nearest(beats.filter((t) => t < len), len / 2);
  if (b === undefined) return null;
  const next = beats.find((t) => t > b);
  const hold = next !== undefined ? next - b : DEFAULT_BEAT_MS;
  const keys: Key[] = [{ t: 0, v: 1, ease: "hold" }, { t: b, v: 0, ease: "hold" }];
  if (b + hold < len) keys.push({ t: b + hold, v: 1, ease: "hold" });
  return param(keys, len);
}

const MAKERS: Record<VelocityPresetId, (markers: readonly Marker[], clip: VelocitySpan) => EditParam | null> = {
  "ramp-into-beat": rampIntoBeat,
  "slow-on-drop": slowOnDrop,
  "fast-to-slow": fastToSlow,
  "freeze-on-beat": freezeOnBeat,
};

/** The speed param for a preset, or null when it doesn't apply to this clip. */
export function velocitySpeed(preset: VelocityPresetId, markers: readonly Marker[], clip: VelocitySpan): EditParam | null {
  return MAKERS[preset](markers, clip);
}
