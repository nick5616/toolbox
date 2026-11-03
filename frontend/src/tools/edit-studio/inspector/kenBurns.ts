/**
 * "Ken Burns on markers" (§14.8): scale keys alternate 1.0 / 1.12 and x/y
 * drift ±0.03 at each marker of the active lane inside the clip. Pure.
 */
import { IDENTITY_TRANSFORM, MAX_KEYS } from "@/viz/edit/schema";
import type { ClipTransform, EditParam, Key, Marker, MarkerLane } from "@/viz/edit/types";
import { paramBase, paramMods } from "./paramOps";

export const KB_SCALE_IN = 1.12;
export const KB_DRIFT = 0.03;

/** Markers of `lane` that fall inside [startMs, endMs) (timeline ms), in time order. */
export function markersInClip(markers: readonly Marker[], lane: MarkerLane, startMs: number, endMs: number): Marker[] {
  return markers.filter((m) => m.lane === lane && m.ms >= startMs && m.ms < endMs).sort((a, b) => a.ms - b.ms);
}

/**
 * The clip's transform with Ken Burns keys, or null when no marker of the lane
 * is inside the clip. Keeps each param's base and reactions; opacity and
 * rotation stay as they are.
 */
export function kenBurns(transform: ClipTransform, markers: readonly Marker[], lane: MarkerLane, clip: { startMs: number; endMs: number }): ClipTransform | null {
  const hits = markersInClip(markers, lane, clip.startMs, clip.endMs).slice(0, MAX_KEYS);
  if (!hits.length) return null;
  const keyed = (p: EditParam, value: (i: number) => number): EditParam => {
    const keys: Key[] = [];
    for (const [i, m] of hits.entries()) {
      const t = Math.round(m.ms - clip.startMs);
      if (keys.length && (keys[keys.length - 1] as Key).t === t) continue;
      keys.push({ t, v: value(i), ease: "ease" });
    }
    const mods = paramMods(p);
    return mods.length ? { base: paramBase(p), keys, mods: [...mods] } : { base: paramBase(p), keys };
  };
  return {
    ...IDENTITY_TRANSFORM,
    ...transform,
    scale: keyed(transform.scale, (i) => (i % 2 === 0 ? 1 : KB_SCALE_IN)),
    x: keyed(transform.x, (i) => (i % 2 === 0 ? -KB_DRIFT : KB_DRIFT)),
    y: keyed(transform.y, (i) => (Math.floor(i / 2) % 2 === 0 ? -KB_DRIFT : KB_DRIFT)),
  };
}
