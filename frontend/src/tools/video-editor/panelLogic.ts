// Pure helpers for the timeline panel.
import type { VideoTitle } from "@/lib/api";
import type { Span } from "./timeline";

export const SNAP_PX = 8;
export const MIN_PPS = 6;
export const MAX_PPS = 800;

export function clampPps(v: number): number {
  return Math.min(MAX_PPS, Math.max(MIN_PPS, v));
}

/** Snaps value to the nearest candidate within thresholdMs; returns value when none is near. */
export function snapMs(value: number, candidates: readonly number[], thresholdMs: number): number {
  let best = value;
  let bestD = thresholdMs + 1;
  for (const c of candidates) {
    const d = Math.abs(c - value);
    if (d <= thresholdMs && d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/** Snap targets: every clip edge, the playhead and the start. */
export function snapPoints(spans: readonly Span[], playheadMs: number, skipClip = -1): number[] {
  const pts = [0, playheadMs];
  for (const s of spans) {
    if (s.index === skipClip) continue;
    pts.push(s.startMs, s.endMs);
  }
  return pts;
}

/** The index a dragged clip should take when its centre is at centerMs. */
export function reorderTarget(spans: readonly Span[], from: number, centerMs: number): number {
  let n = 0;
  for (const s of spans) {
    if (s.index === from) continue;
    if ((s.startMs + s.endMs) / 2 < centerMs) n++;
  }
  return n;
}

/** Ruler tick spacing (seconds) giving at least minPx between labels. */
export function rulerStepSec(pps: number, minPx = 72): number {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((s) => s * pps >= minPx) ?? 600;
}

/** Puts overlapping titles on separate rows (greedy, in start order). */
export function titleRows(titles: readonly VideoTitle[]): Map<string, number> {
  const rows = new Map<string, number>();
  const ends: number[] = [];
  for (const t of [...titles].sort((a, b) => a.startMs - b.startMs)) {
    let r = ends.findIndex((e) => e <= t.startMs);
    if (r < 0) {
      r = ends.length;
      ends.push(0);
    }
    ends[r] = t.startMs + t.durationMs;
    rows.set(t.id, r);
  }
  return rows;
}

/** The slice of a song's peaks that lies under the video. */
export function musicPeaksWindow(peaks: readonly number[], songMs: number, offsetMs: number, spanMs: number): number[] {
  if (peaks.length === 0 || songMs <= 0) return [];
  const a = Math.min(Math.max(offsetMs / songMs, 0), 1);
  const b = Math.min(Math.max((offsetMs + spanMs) / songMs, 0), 1);
  const from = Math.floor(a * peaks.length);
  const to = Math.max(from + 1, Math.ceil(b * peaks.length));
  return peaks.slice(from, to);
}
