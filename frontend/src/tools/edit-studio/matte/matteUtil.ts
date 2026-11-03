/**
 * Pure helpers for cut-outs (Phase 9 SPEC §10): status, ranges, clicks, the time estimate.
 */
import type { EditClip, EditMatte, EditMatteClick, EditMatteState } from "@/lib/api";

export type MatteMode = "people" | "select" | "image";
export type MatteStatus = "none" | "making" | "ready" | "stale" | "missing" | "failed";
export type JobPhase = "active" | "failed" | "none";

/** Subject select covers at most this much of a clip (§10.5). */
export const MAX_SELECT_MS = 60_000;
/** SAM runs on at most this many frames per second of source (§22.7). */
export const SAM_FPS = 15;
/** Measured CPU cost of one sampled frame (§22.7). */
export const SECONDS_PER_SAMPLED_FRAME = 2;
/** Go pads the range by this much on both sides (§10.5). */
export const PAD_MS = 500;
/** Matte clicks per request (§15 / Go MaxClicks). */
export const MAX_CLICKS = 64;

export interface SourceSpan {
  fromMs: number;
  toMs: number;
}

/** The mode a clip can use: photos only `image`, videos `people` or `select`. */
export function modesFor(kind: EditClip["kind"]): MatteMode[] {
  if (kind === "image") return ["image"];
  if (kind === "video") return ["people", "select"];
  return [];
}

export const MODE_LABEL: Record<MatteMode, string> = { image: "Photo", people: "People", select: "Select a subject" };

/** Is the source range covered by a ready matte? (Image mattes have no range.) */
export function covers(state: Pick<EditMatteState, "fromMs" | "toMs">, span: SourceSpan): boolean {
  return span.fromMs >= state.fromMs && span.toMs <= state.toMs;
}

/** What the Inspector says about a clip's matte. */
export function matteStatus(matte: EditMatte | null, state: EditMatteState | undefined, span: SourceSpan, job: JobPhase): MatteStatus {
  if (!matte) return "none";
  if (job === "active") return "making";
  if (job === "failed") return "failed";
  if (!state?.ready) return "missing";
  if (matte.mode === "image") return "ready";
  return covers(state, span) ? "ready" : "stale";
}

/** The frame-snapped ms of the frame nearest to ms (a click's time). */
export function snapMs(ms: number, fps: number): number {
  return Math.round(Math.round((ms * fps) / 1000) * (1000 / fps));
}

export function frameOfMs(ms: number, fps: number): number {
  return Math.round((ms * fps) / 1000);
}

/** Clicks on the frame at ms come first (the preview uses the first click's frame); the others keep their order. */
export function clicksFor(clicks: readonly EditMatteClick[], ms: number, fps: number): EditMatteClick[] {
  const f = frameOfMs(ms, fps);
  const here = clicks.filter((c) => frameOfMs(c.ms, fps) === f);
  const rest = clicks.filter((c) => frameOfMs(c.ms, fps) !== f);
  return [...here, ...rest];
}

export function hasPositive(clicks: readonly EditMatteClick[]): boolean {
  return clicks.some((c) => c.positive);
}

/** Do two click lists differ (ms, x, y, sign)? */
export function sameClicks(a: readonly EditMatteClick[], b: readonly EditMatteClick[]): boolean {
  return a.length === b.length && a.every((c, i) => c.ms === b[i]?.ms && c.x === b[i]?.x && c.y === b[i]?.y && c.positive === b[i]?.positive);
}

/** Frames SAM runs on for a source range (≤ 15 per second, plus the padding and the last frame). */
export function sampledFrames(spanMs: number, fps: number): number {
  const step = Math.max(1, Math.ceil(fps / SAM_FPS - 1e-9));
  const frames = Math.max(1, Math.round(((spanMs + 2 * PAD_MS) * fps) / 1000));
  return Math.ceil(frames / step) + 1;
}

export function estimateSeconds(spanMs: number, fps: number): number {
  return sampledFrames(spanMs, fps) * SECONDS_PER_SAMPLED_FRAME;
}

/** "under a minute" / "about 3 minutes". */
export function describeEstimate(seconds: number): string {
  if (seconds < 45) return "under a minute";
  const minutes = Math.round(seconds / 60);
  return minutes <= 1 ? "about a minute" : `about ${minutes} minutes`;
}

/** The matte a new job stores in the clip; keeps the look settings of the previous one. */
export function makeMatte(mode: MatteMode, id: string, span: SourceSpan, clicks: EditMatteClick[], prev: EditMatte | null): EditMatte {
  return {
    mode,
    id,
    fromMs: mode === "image" ? 0 : span.fromMs,
    toMs: mode === "image" ? 0 : span.toMs,
    clicks: mode === "select" ? clicks : [],
    cutout: prev ? prev.cutout : true,
    invert: prev?.invert ?? false,
    feather: prev?.feather ?? 0,
    stroke: prev?.stroke ?? { px: 0, color: "#ffffff" },
    glow: prev?.glow ?? { amount: 0, color: "#ffffff" },
  };
}
