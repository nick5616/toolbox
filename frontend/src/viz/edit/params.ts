/**
 * EditParam evaluation (Phase 9 SPEC §6.3): keyframes, signal mods with marker
 * signals, section gates. Pure and deterministic.
 *
 *   value = (keys ? interpolate(keys, u) : base) + Σ mod.amount · (max − min) · shape(env(mod, s)),
 *   clamped to [min, max]
 */
import { DEFAULT_ATTACK_MS, DEFAULT_RELEASE_MS, SIGNAL_META, shape, type Signals } from "../signals";
import type { MarkerSignals } from "./markerSignals";
import { isMarkerSignal } from "./schema";
import type { EditMod, EditParam, Key, MarkerLane } from "./types";

export interface ParamContext {
  signals: Signals;
  markers: MarkerSignals | null;
}

const smooth = (x: number) => x * x * (3 - 2 * x);

/** Cubic ease in / out / in-out (Phase 21 SPEC §B3). */
export const easeIn = (x: number): number => x * x * x;
export const easeOut = (x: number): number => 1 - (1 - x) ** 3;
export const easeInOut = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

/**
 * CSS cubic-bezier(x1, y1, x2, y2) at progress x in 0..1: the curve's x(s) is
 * inverted by Newton's method (8 steps) with a bisection fallback when the
 * slope is too flat or Newton leaves [0, 1]; the result is y(s). y may leave
 * 0..1 (overshoot).
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bx = (s: number) => ((1 - 3 * x2 + 3 * x1) * s + (3 * x2 - 6 * x1)) * s * s + 3 * x1 * s;
  const by = (s: number) => ((1 - 3 * y2 + 3 * y1) * s + (3 * y2 - 6 * y1)) * s * s + 3 * y1 * s;
  const dbx = (s: number) => (3 * (1 - 3 * x2 + 3 * x1) * s + 2 * (3 * x2 - 6 * x1)) * s + 3 * x1;
  let s = x;
  for (let i = 0; i < 8; i++) {
    const err = bx(s) - x;
    if (Math.abs(err) < 1e-7) return by(s);
    const d = dbx(s);
    if (Math.abs(d) < 1e-6) break;
    s -= err / d;
    if (s < 0 || s > 1) break;
  }
  let lo = 0;
  let hi = 1;
  s = x;
  for (let i = 0; i < 60; i++) {
    const v = bx(s);
    if (Math.abs(v - x) < 1e-9) break;
    if (v < x) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return by(s);
}

/** Progress through a segment after the starting key's ease (hold is handled by the caller). */
export function easeProgress(k: Pick<Key, "ease" | "bez">, x: number): number {
  switch (k.ease) {
    case "ease":
      return smooth(x);
    case "in":
      return easeIn(x);
    case "out":
      return easeOut(x);
    case "inout":
      return easeInOut(x);
    case "bezier":
      return k.bez ? cubicBezier(k.bez[0], k.bez[1], k.bez[2], k.bez[3], x) : smooth(x);
    default:
      return x;
  }
}

/**
 * The keyframed value at clip time u (keys sorted by t). Holds the first/last
 * key outside the range; a segment uses its starting key's ease: linear,
 * ease (smoothstep), cubic in/out/inout, bezier, or hold (a step at the next key).
 */
export function interpolateKeys(keys: readonly Key[], u: number): number {
  const n = keys.length;
  if (n === 0) return 0;
  const first = keys[0] as Key;
  if (n === 1 || u <= first.t) return first.v;
  const last = keys[n - 1] as Key;
  if (u >= last.t) return last.v;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((keys[mid] as Key).t <= u) lo = mid;
    else hi = mid;
  }
  const a = keys[lo] as Key;
  const b = keys[hi] as Key;
  if (a.ease === "hold" || b.t <= a.t) return a.v;
  const x = (u - a.t) / (b.t - a.t);
  return a.v + (b.v - a.v) * easeProgress(a, x);
}

/** A mod's envelope at song ms, with the section gate applied (0..1). */
function envOf(m: EditMod, songMs: number, ctx: ParamContext): number {
  if (m.sections && m.sections.length) {
    const label = ctx.signals.analysis.sectionAt(songMs)?.section.label;
    if (!label || !m.sections.includes(label)) return 0;
  }
  const attack = m.attackMs ?? DEFAULT_ATTACK_MS;
  const release = m.releaseMs ?? DEFAULT_RELEASE_MS;
  let x: number;
  if (isMarkerSignal(m.signal)) {
    if (!ctx.markers) return 0;
    x = ctx.markers.value(m.signal.slice("marker.".length) as MarkerLane, { every: m.every, sections: m.sections }, songMs, attack, release);
  } else {
    if (!SIGNAL_META.has(m.signal as never)) return 0;
    x = ctx.signals.value(m.signal as never, songMs, attack, release);
  }
  return Math.max(0, Math.min(1, x));
}

/**
 * Resolves a parameter. clipMs is clip-relative (keys); songMs samples the
 * signals. With no context, mods are ignored.
 */
export function evalEditParam(p: EditParam, min: number, max: number, clipMs: number, songMs: number, ctx: ParamContext | null): number {
  if (typeof p === "number") return Math.max(min, Math.min(max, p));
  let v = p.keys && p.keys.length ? interpolateKeys(p.keys, clipMs) : p.base;
  if (ctx && p.mods && p.mods.length) {
    const range = max - min;
    for (const m of p.mods) v += m.amount * range * shape(envOf(m, songMs, ctx), m.shape);
  }
  return Math.max(min, Math.min(max, v));
}
