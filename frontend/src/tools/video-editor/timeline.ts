// Timeline maths, mirrored from modules/videoeditor/timeline.go (SPEC.md Part B §B6.1).
// modules/videoeditor/testdata/timeline.json holds the shared vectors.
import type { VideoClip } from "@/lib/api";

/** One clip's place on the timeline, in milliseconds. */
export interface Span {
  index: number;
  startMs: number;
  endMs: number;
  /** The clip's own length after speed. */
  lenMs: number;
  /** Overlap with the next clip (its transition); 0 for cuts and the last clip. */
  overlapMs: number;
}

export const MIN_CLIP_MS = 300;
export const MIN_PHOTO_MS = 1000;
export const MAX_PHOTO_MS = 10000;
export const MIN_TRANSITION_MS = 200;
export const MAX_TRANSITION_MS = 1500;
export const MAX_TOTAL_MS = 30 * 60 * 1000;

/** The clip fields that matter for the maths (tests pass partial clips). */
export type TimedClip = Pick<VideoClip, "kind" | "inMs" | "outMs" | "durationMs" | "speed" | "transition">;

export function speedOf(c: Pick<VideoClip, "speed">): number {
  return c.speed > 0 ? c.speed : 1;
}

/** A clip's length on the timeline: (out - in) / speed for video, DurationMs for photos. */
export function clipLenMs(c: TimedClip): number {
  if (c.kind === "image") return c.durationMs;
  const n = Math.max(c.outMs - c.inMs, 0);
  return Math.floor(n / speedOf(c) + 0.5);
}

/** The overlap between clip i and i+1, clamped to half of either neighbour. */
export function overlapMs(clips: readonly TimedClip[], i: number): number {
  const a = clips[i];
  const b = clips[i + 1];
  if (!a || !b) return 0;
  const t = a.transition;
  if (!t || t.kind === "" || t.kind === "cut" || t.durationMs <= 0) return 0;
  return Math.min(t.durationMs, Math.floor(clipLenMs(a) / 2), Math.floor(clipLenMs(b) / 2));
}

/** Each clip's span. */
export function timeline(clips: readonly TimedClip[]): Span[] {
  const spans: Span[] = [];
  let start = 0;
  clips.forEach((c, i) => {
    const l = clipLenMs(c);
    const ov = overlapMs(clips, i);
    spans.push({ index: i, startMs: start, endMs: start + l, lenMs: l, overlapMs: ov });
    start += l - ov;
  });
  return spans;
}

export function durationMs(clips: readonly TimedClip[]): number {
  const last = timeline(clips).at(-1);
  return last ? last.endMs : 0;
}

/** "9:16" -> 9/16 (falls back to 9/16). */
export function aspectRatio(aspect: string): number {
  const [w, h] = aspect.split(":").map(Number);
  return w && h && w > 0 && h > 0 ? w / h : 9 / 16;
}
