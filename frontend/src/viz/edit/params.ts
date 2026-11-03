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

/**
 * The keyframed value at clip time u (keys sorted by t). Holds the first/last
 * key outside the range; a segment uses its starting key's ease: linear,
 * ease (smoothstep) or hold (a step at the next key).
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
  return a.v + (b.v - a.v) * (a.ease === "ease" ? smooth(x) : x);
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
