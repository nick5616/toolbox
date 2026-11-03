/**
 * Magnetic snapping for the tracks (Phase 9 SPEC §14.5). Targets: markers of
 * the visible lanes, clip edges on all tracks, the playhead, 0 and D. Pure.
 */
import type { NormalProject } from "@/viz/edit/defaults";
import { laneSettings } from "@/viz/edit/defaults";
import { editLength, type Marker } from "@/viz/edit/types";
import { SNAP_PX } from "../geometry";

export interface SnapTarget {
  /** Timeline ms. */
  ms: number;
  /** Shown in the hint chip: "kick", "downbeat", "clip edge", "playhead", "start", "end". */
  label: string;
}

export interface SnapInput {
  project: NormalProject;
  markers: readonly Marker[];
  playheadMs: number;
  /** Clips being dragged: their own edges aren't targets. */
  exclude?: ReadonlySet<string>;
}

/** All targets, ascending by time. */
export function buildSnapTargets(input: SnapInput): SnapTarget[] {
  const { project, markers, playheadMs, exclude } = input;
  const out: SnapTarget[] = [{ ms: 0, label: "start" }, { ms: Math.round(playheadMs), label: "playhead" }];
  const D = editLength(project);
  if (D > 0) out.push({ ms: D, label: "end" });
  for (const m of markers) if (laneSettings(project.markers, m.lane).visible) out.push({ ms: m.ms, label: m.lane });
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (exclude?.has(c.id)) continue;
      out.push({ ms: c.startMs, label: "clip edge" }, { ms: c.endMs, label: "clip edge" });
    }
  }
  return out.sort((a, b) => a.ms - b.ms);
}

/** The threshold in ms at a zoom. */
export function snapThresholdMs(pps: number): number {
  return (SNAP_PX * 1000) / Math.max(1, pps);
}

/** The nearest target within the threshold of ms (ties: the earlier one), or null. `targets` must be ascending. */
export function snapPoint(ms: number, targets: readonly SnapTarget[], pps: number): SnapTarget | null {
  if (!targets.length) return null;
  let lo = 0;
  let hi = targets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((targets[mid] as SnapTarget).ms < ms) lo = mid + 1;
    else hi = mid;
  }
  const limit = snapThresholdMs(pps);
  let best: SnapTarget | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const i of [lo - 1, lo]) {
    const t = targets[i];
    if (!t) continue;
    const d = Math.abs(t.ms - ms);
    if (d <= limit && d < bestD) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

export interface SpanSnap {
  /** Add to the move delta. */
  deltaMs: number;
  target: SnapTarget | null;
}

/** Snaps a dragged span: whichever edge is nearer a target wins (the start edge on a tie). */
export function snapSpan(startMs: number, endMs: number, targets: readonly SnapTarget[], pps: number): SpanSnap {
  const a = snapPoint(startMs, targets, pps);
  const b = snapPoint(endMs, targets, pps);
  if (a && (!b || Math.abs(a.ms - startMs) <= Math.abs(b.ms - endMs))) return { deltaMs: a.ms - startMs, target: a };
  if (b) return { deltaMs: b.ms - endMs, target: b };
  return { deltaMs: 0, target: null };
}
