/**
 * Velocity ramps: the "slow on the hit, fast in between" speed curves of
 * velocity edits, written as a clip's speed keys.
 *
 * - Hits are clip-relative timeline ms: the cut itself (0) and/or markers of a
 *   lane inside the clip.
 * - Shapes:
 *   - "hit": slow on each hit, ramping up fast between hits (the classic);
 *   - "rush": fast rushing into each hit, slowing right on it, snapping back;
 *   - "start": starts slow on the hit and accelerates until the next one.
 * - Intensity 0..1 sets how slow the slow part is against the fast part.
 * - The curve is scaled so the clip plays exactly as much footage as a
 *   normal-speed clip would (or what's left of the source, if less): the ramp
 *   changes the feel, never runs out of footage, and the next clip's timing is untouched.
 *
 * Speeds are piecewise linear between keys (ease "linear"), so the footage the
 * clip uses is the curve's area, computed exactly here.
 */
import { MAX_KEYS, SPEED_MAX } from "@/viz/edit/schema";
import type { EditParam, Key, Marker, MarkerLane } from "@/viz/edit/types";

export type VelocityShape = "hit" | "rush" | "start";

export const VELOCITY_SHAPES: ReadonlyArray<{ value: VelocityShape; label: string; tip: string }> = [
  { value: "hit", label: "Slow on the hit", tip: "Slows right on each hit and speeds up between them: the classic velocity edit" },
  { value: "rush", label: "Rush into the hit", tip: "Speeds up into each hit, slows on it, then snaps back" },
  { value: "start", label: "Slow, then fast", tip: "Starts slow on the hit and accelerates until the next one" },
];

/** What the ramp's slow points follow: the cut (clip start) or a lane's markers inside the clip. */
export type VelocityHits = "cut" | MarkerLane;

export const VELOCITY_HITS: ReadonlyArray<{ value: VelocityHits; label: string }> = [
  { value: "cut", label: "The cut" },
  { value: "beat", label: "Beats" },
  { value: "downbeat", label: "Downbeats" },
  { value: "kick", label: "Kicks" },
  { value: "snare", label: "Snares" },
  { value: "accent", label: "Accents" },
];

export interface VelocitySettings {
  shape: VelocityShape;
  hits: VelocityHits;
  /** 0..1 */
  intensity: number;
}

export const DEFAULT_VELOCITY: VelocitySettings = { shape: "hit", hits: "cut", intensity: 0.7 };

const MIN_SPEED = 0.08;
const MIN_CLIP_MS = 300;
const MAX_HITS = 12;

/** Clip-relative hit times: the cut and/or the lane's markers inside the clip, ≥ 200 ms apart. */
export function hitTimes(markers: readonly Marker[], hits: VelocityHits, startMs: number, endMs: number): number[] {
  const len = endMs - startMs;
  const ts = hits === "cut" ? [0] : [0, ...markers.filter((m) => m.lane === hits && m.ms > startMs && m.ms < endMs - 80).map((m) => m.ms - startMs)];
  const out: number[] = [];
  for (const t of ts.sort((a, b) => a - b)) {
    const r = Math.round(t);
    if (r < 0 || r > len) continue;
    if (out.length && r - (out[out.length - 1] as number) < 200) continue;
    out.push(r);
    if (out.length >= MAX_HITS) break;
  }
  return out;
}

/** The unscaled curve: key times and relative speeds. */
function shapeKeys(shape: VelocityShape, len: number, hits: readonly number[], slow: number, fast: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  const segs = hits.length ? hits : [0];
  segs.forEach((h, i) => {
    const next = (segs[i + 1] as number | undefined) ?? len;
    const gap = Math.max(1, next - h);
    if (shape === "hit") {
      // slow on the hit, fast in the middle of the gap, easing back to slow at the next hit
      // (a short slow-mo moment of about 0.3 s, then the footage rushes)
      const hold = Math.min(gap * 0.3, 320);
      pts.push([h, slow], [h + hold, slow * 1.2], [h + Math.min(gap * 0.55, hold + 280), fast], [h + gap * 0.88, fast * 0.85 + slow * 0.15]);
    } else if (shape === "rush") {
      // snap back fast right after the hit, rush, brake into the next hit
      pts.push([h, slow], [h + Math.min(gap * 0.15, 120), fast], [h + gap * 0.7, fast], [h + gap * 0.92, slow]);
    } else {
      // slow on the hit, accelerating to the next one
      pts.push([h, slow], [h + gap * 0.45, slow + (fast - slow) * 0.3], [h + gap * 0.95, fast]);
    }
  });
  if ((pts[0]?.[0] ?? 0) > 0) pts.unshift([0, shape === "start" ? fast : (pts[0]?.[1] ?? 1)]);
  const last = pts[pts.length - 1];
  if (last && last[0] < len) pts.push([len, shape === "hit" ? slow + (fast - slow) * 0.5 : last[1]]);
  // strictly increasing times inside [0, len]
  const out: Array<[number, number]> = [];
  for (const [t, v] of pts) {
    const tt = Math.max(0, Math.min(len, Math.round(t)));
    if (out.length && tt <= (out[out.length - 1] as [number, number])[0]) continue;
    out.push([tt, v]);
  }
  return out;
}

/** Footage used (source ms) by a piecewise-linear speed curve over [0, len]. */
export function areaOf(pts: ReadonlyArray<readonly [number, number]>, len: number): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [t0, v0] = pts[i] as readonly [number, number];
    const [t1, v1] = (pts[i + 1] as readonly [number, number] | undefined) ?? [len, v0];
    a += ((v0 + v1) / 2) * Math.max(0, Math.min(len, t1) - t0);
  }
  const first = pts[0];
  if (first && first[0] > 0) a += first[1] * first[0];
  return a;
}

/**
 * Speed keys for a velocity ramp on a clip of `lenMs`, or null when the clip
 * is too short. `sourceRoomMs` is the footage left after the clip's in point
 * (Infinity when unknown); the ramp uses min(lenMs, sourceRoomMs) of it.
 */
export function velocityRamp(s: VelocitySettings, lenMs: number, hits: readonly number[], sourceRoomMs = Number.POSITIVE_INFINITY): EditParam | null {
  const len = Math.round(lenMs);
  if (len < MIN_CLIP_MS) return null;
  const i = Math.max(0, Math.min(1, s.intensity));
  const slow = 1 - 0.85 * i; // relative to fast
  const fast = 1 + 1.5 * i;
  let pts = shapeKeys(s.shape, len, hits, slow, fast);
  const target = Math.max(1, Math.min(len, sourceRoomMs));
  // Scale so the curve's area is the target; clamping can move it, so settle twice.
  for (let k = 0; k < 3; k++) {
    const area = areaOf(pts, len);
    if (area <= 0) break;
    const f = target / area;
    pts = pts.map(([t, v]) => [t, Math.max(MIN_SPEED, Math.min(SPEED_MAX, v * f))] as [number, number]);
  }
  const keys: Key[] = pts.slice(0, MAX_KEYS).map(([t, v]) => ({ t, v: Math.round(v * 1000) / 1000, ease: "linear" }));
  return { base: keys[0]?.v ?? 1, keys };
}
