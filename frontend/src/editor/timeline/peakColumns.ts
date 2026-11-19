/**
 * Waveform columns for a clip (Phase 21 SPEC §B2): reduces `Peaks` (min/max
 * per 10 ms, int8) to one min/max pair per pixel column of the visible part
 * of a clip. Pure.
 */
import type { EditClip } from "@/lib/api";
import type { Peaks } from "@/editor/audio/types";
import { sourceWindow } from "./clipInfo";

export interface Columns {
  /** −1..1 per column. */
  min: Float32Array;
  max: Float32Array;
}

/** The most columns one clip's canvas draws (a clip wider than the window only draws what's visible). */
export const MAX_COLUMNS = 2400;

/** Peaks of the source range [fromMs, toMs) reduced to `columns` columns. Beyond the file's end: silence. */
export function peakColumns(peaks: Peaks, fromMs: number, toMs: number, columns: number): Columns {
  const n = Math.max(0, Math.min(MAX_COLUMNS, Math.floor(columns)));
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  const span = toMs - fromMs;
  const total = Math.min(peaks.min.length, peaks.max.length);
  if (n === 0 || !(span > 0) || !(peaks.rate > 0)) return { min, max };
  for (let c = 0; c < n; c++) {
    const a = ((fromMs + (span * c) / n) / 1000) * peaks.rate;
    const b = ((fromMs + (span * (c + 1)) / n) / 1000) * peaks.rate;
    const i0 = Math.max(0, Math.floor(a));
    const i1 = Math.min(total, Math.max(i0 + 1, Math.ceil(b)));
    let lo = 0;
    let hi = 0;
    for (let i = i0; i < i1; i++) {
      const l = (peaks.min[i] as number) / 127;
      const h = (peaks.max[i] as number) / 127;
      if (l < lo) lo = l;
      if (h > hi) hi = h;
    }
    min[c] = Math.max(-1, lo);
    max[c] = Math.min(1, hi);
  }
  return { min, max };
}

/**
 * The source range behind a visible pixel range of a clip (clip-relative px, at
 * `pps`), assuming an even speed across the clip (a ramp draws as its average).
 */
export function visibleSourceRange(clip: EditClip, fps: number, pps: number, fromPx: number, toPx: number): { fromMs: number; toMs: number } {
  const len = clip.endMs - clip.startMs;
  const w = sourceWindow(clip, fps);
  const rate = len > 0 ? (w.toMs - w.fromMs) / len : 1;
  const at = (px: number): number => clip.inMs + ((px * 1000) / pps) * rate;
  return { fromMs: at(fromPx), toMs: at(toPx) };
}
