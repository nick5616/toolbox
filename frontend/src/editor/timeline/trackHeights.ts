/**
 * Track row heights (Phase 21 SPEC §B2): each track is small, medium or large
 * (`Track.Height`). Pure; the panel and the header's resize edge use it.
 */
import type { TrackHeight } from "./ops";

export type RowKind = "video" | "audio" | "adjust";

const ROW_PX: Record<RowKind, Record<TrackHeight, number>> = {
  video: { s: 34, m: 56, l: 96 },
  audio: { s: 30, m: 52, l: 92 },
  adjust: { s: 26, m: 36, l: 56 },
};

const rowKind = (kind: string): RowKind => (kind === "audio" || kind === "adjust" ? kind : "video");

/** The row's height in px. `thin` (Edit Studio's Music view) forces the smallest. */
export function rowPx(kind: string, height: TrackHeight, thin = false): number {
  return ROW_PX[rowKind(kind)][thin ? "s" : height];
}

/** Room between the row's edge and a clip (3 px above and below, 1 px border each). */
export const CLIP_INSET_PX = 8;

/** The height of the lane inside a clip on a row. */
export const lanePx = (rowHeightPx: number): number => rowHeightPx - CLIP_INSET_PX;

/** The size nearest to a dragged row height. */
export function nearestHeight(kind: string, px: number): TrackHeight {
  const t = ROW_PX[rowKind(kind)];
  let best: TrackHeight = "m";
  let bestD = Number.POSITIVE_INFINITY;
  for (const h of ["s", "m", "l"] as const) {
    const d = Math.abs(t[h] - px);
    if (d < bestD) {
      best = h;
      bestD = d;
    }
  }
  return best;
}
