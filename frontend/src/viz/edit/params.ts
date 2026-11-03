/**
 * EditParam evaluation (Phase 9 SPEC §6.3). WP-ES1 implements keys, mods and
 * section gates; the signatures are frozen (the Wave 0 stub returns the
 * clamped base).
 */
import type { Signals } from "../signals";
import type { MarkerSignals } from "./markerSignals";
import type { EditParam, Key } from "./types";

export interface ParamContext {
  signals: Signals;
  markers: MarkerSignals | null;
}

/** The keyframed value at clip time u (holds outside the keys). */
export function interpolateKeys(keys: readonly Key[], u: number): number {
  void u;
  return keys[0]?.v ?? 0;
}

/**
 * value = (keys ? interpolate(keys, clipMs) : base) + Σ mods, clamped to [min, max].
 * clipMs is clip-relative; songMs samples the signals.
 */
export function evalEditParam(p: EditParam, min: number, max: number, clipMs: number, songMs: number, ctx: ParamContext | null): number {
  void clipMs;
  void songMs;
  void ctx;
  const v = typeof p === "number" ? p : p.base;
  return Math.max(min, Math.min(max, v));
}
