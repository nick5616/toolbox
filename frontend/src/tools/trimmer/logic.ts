import { TrimAspect, TrimJoin, TrimMode, type MediaInfo, type TrimmerOptions, type TrimSegment } from "@/lib/api";

/** A segment in the editor (ids are local; segments are not persisted). */
export interface Seg {
  id: string;
  startMs: number;
  endMs: number;
}

export const MIN_SEGMENT_MS = 100;
export const MAX_SEGMENTS = 50;
export const NEW_SEGMENT_MS = 5000;
/** A fast-mode start that moves back at least this far gets a note. */
export const KEYFRAME_NOTE_MS = 100;
export const SIZE_PRESETS = [10, 25, 50, 100] as const;
export const HEIGHTS = [0, 2160, 1440, 1080, 720, 480] as const;

/** The persisted part of the options (everything but the segments). */
export type TrimmerSettings = Omit<TrimmerOptions, "segments">;

export const DEFAULT_SETTINGS: TrimmerSettings = {
  mode: TrimMode.ModeFast,
  join: TrimJoin.JoinMerge,
  aspect: TrimAspect.AspectKeep,
  cropX: 0.5,
  cropY: 0.5,
  maxSizeMB: 0,
  maxHeight: 0,
  removeAudio: false,
};

const MODES: string[] = [TrimMode.ModeFast, TrimMode.ModePrecise];
const JOINS: string[] = [TrimJoin.JoinMerge, TrimJoin.JoinSeparate];
const ASPECTS: string[] = [TrimAspect.AspectKeep, TrimAspect.AspectPortrait, TrimAspect.AspectSquare, TrimAspect.AspectFourFive, TrimAspect.AspectWide];

const unit = (v: unknown, d: number): number => (typeof v === "number" && v >= 0 && v <= 1 ? v : d);

/** Merges saved module state over the defaults, dropping anything invalid. */
export function sanitizeSettings(saved: unknown, d: TrimmerSettings): TrimmerSettings {
  if (typeof saved !== "object" || saved === null) return d;
  const s = saved as Record<string, unknown>;
  const size = s.maxSizeMB;
  const height = s.maxHeight;
  const out: TrimmerSettings = {
    mode: typeof s.mode === "string" && MODES.includes(s.mode) ? (s.mode as TrimMode) : d.mode,
    join: typeof s.join === "string" && JOINS.includes(s.join) ? (s.join as TrimJoin) : d.join,
    aspect: typeof s.aspect === "string" && ASPECTS.includes(s.aspect) ? (s.aspect as TrimAspect) : d.aspect,
    cropX: unit(s.cropX, d.cropX),
    cropY: unit(s.cropY, d.cropY),
    maxSizeMB: typeof size === "number" && Number.isInteger(size) && size >= 0 && size <= 4000 ? size : d.maxSizeMB,
    maxHeight: typeof height === "number" && (HEIGHTS as readonly number[]).includes(height) ? height : d.maxHeight,
    removeAudio: typeof s.removeAudio === "boolean" ? s.removeAudio : d.removeAudio,
  };
  // Re-encoding options are only valid with Precise.
  if (out.mode === TrimMode.ModeFast && needsPrecise(out)) out.mode = TrimMode.ModePrecise;
  return out;
}

/** True when the settings need a re-encode. */
export function needsPrecise(s: Pick<TrimmerSettings, "aspect" | "maxSizeMB" | "maxHeight">): boolean {
  return s.aspect !== TrimAspect.AspectKeep || s.maxSizeMB > 0 || s.maxHeight > 0;
}

/** "9:16" becomes 9/16; Keep becomes null. */
export function aspectRatio(a: TrimAspect): number | null {
  const m = /^(\d+):(\d+)$/.exec(a);
  if (!m) return null;
  return Number(m[1]) / Number(m[2]);
}

/** Display aspect (width / height) of the source picture, rotation applied; null for audio. */
export function sourceAspect(info: MediaInfo | undefined): number | null {
  const v = info?.video;
  if (!v || !v.width || !v.height) return null;
  const rot = Math.abs(v.rotation || 0) % 180;
  return rot === 90 ? v.height / v.width : v.width / v.height;
}

let counter = 0;
export function newSegId(): string {
  counter += 1;
  return `seg-${counter}`;
}

export function fullSegment(durationMs: number): Seg {
  return { id: newSegId(), startMs: 0, endMs: Math.max(0, Math.round(durationMs)) };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Sets the start of one segment; keeps it MIN before its end and after the previous segment. */
export function setStart(segs: Seg[], id: string, ms: number): Seg[] {
  const i = segs.findIndex((s) => s.id === id);
  const cur = segs[i];
  if (!cur) return segs;
  const prevEnd = segs[i - 1]?.endMs ?? 0;
  const start = clamp(Math.round(ms), prevEnd, cur.endMs - MIN_SEGMENT_MS);
  return segs.map((s) => (s.id === id ? { ...s, startMs: start } : s));
}

/** Sets the end of one segment; keeps it MIN after its start and before the next segment. */
export function setEnd(segs: Seg[], id: string, ms: number, durationMs: number): Seg[] {
  const i = segs.findIndex((s) => s.id === id);
  const cur = segs[i];
  if (!cur) return segs;
  const nextStart = segs[i + 1]?.startMs ?? durationMs;
  const end = clamp(Math.round(ms), cur.startMs + MIN_SEGMENT_MS, nextStart);
  return segs.map((s) => (s.id === id ? { ...s, endMs: end } : s));
}

/**
 * Adds a segment of NEW_SEGMENT_MS (or up to the next segment / the end) at
 * `atMs`. When there is no room there, uses the first gap anywhere. Returns
 * the new list and the new id, or null when full or no gap exists.
 */
export function addSegment(segs: Seg[], atMs: number, durationMs: number): { segs: Seg[]; id: string } | null {
  if (segs.length >= MAX_SEGMENTS) return null;
  const sorted = [...segs].sort((a, b) => a.startMs - b.startMs);
  let start = clamp(Math.round(atMs), 0, durationMs);
  const inside = sorted.find((s) => start >= s.startMs && start < s.endMs);
  if (inside) start = inside.endMs;
  const next = sorted.find((s) => s.startMs >= start);
  const limit = next ? next.startMs : durationMs;
  let end = Math.min(start + NEW_SEGMENT_MS, limit);
  if (end - start < MIN_SEGMENT_MS) {
    let cursor = 0;
    let found: { s: number; e: number } | null = null;
    for (const s of [...sorted, { startMs: durationMs, endMs: durationMs }]) {
      if (s.startMs - cursor >= MIN_SEGMENT_MS) {
        found = { s: cursor, e: Math.min(cursor + NEW_SEGMENT_MS, s.startMs) };
        break;
      }
      cursor = Math.max(cursor, s.endMs);
    }
    if (!found) return null;
    start = found.s;
    end = found.e;
  }
  const seg: Seg = { id: newSegId(), startMs: start, endMs: end };
  return { segs: [...segs, seg].sort((a, b) => a.startMs - b.startMs), id: seg.id };
}

/** Applies range edits from the Timeline, rejecting results that overlap or get too short. */
export function applyRanges(prev: Seg[], ranges: { id: string; startMs: number; endMs: number }[]): Seg[] {
  const next = prev.map((s) => {
    const r = ranges.find((x) => x.id === s.id);
    return r ? { ...s, startMs: Math.round(r.startMs), endMs: Math.round(r.endMs) } : s;
  });
  const sorted = [...next].sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (!s || s.endMs - s.startMs < MIN_SEGMENT_MS) return prev;
    const p = sorted[i - 1];
    if (p && s.startMs < p.endMs) return prev;
  }
  return sorted;
}

/** Latest keyframe at or before `ms`; undefined when there is none. */
export function keyframeAtOrBefore(keyframes: readonly number[], ms: number): number | undefined {
  let lo = 0;
  let hi = keyframes.length - 1;
  let best: number | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = keyframes[mid] as number;
    if (k <= ms) {
      best = k;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/** How far a fast-mode cut at `startMs` lands before it (0 when no note is warranted). */
export function keyframeShiftMs(keyframes: readonly number[] | undefined, startMs: number): number {
  if (!keyframes || keyframes.length === 0) return 0;
  const k = keyframeAtOrBefore(keyframes, startMs) ?? 0;
  const shift = startMs - k;
  return shift >= KEYFRAME_NOTE_MS ? shift : 0;
}

/** "starts 1.4 s earlier (keyframe)". */
export function keyframeNote(shiftMs: number): string {
  return `starts ${(shiftMs / 1000).toFixed(1)} s earlier (keyframe)`;
}

export function totalMs(segs: readonly Seg[]): number {
  return segs.reduce((n, s) => n + Math.max(0, s.endMs - s.startMs), 0);
}

/** "1:23" / "1:02:03": whole-second duration for summaries. */
export function formatClock(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Estimated output size in bytes; null when it depends on the content. */
export function estimateBytes(settings: Pick<TrimmerSettings, "mode" | "maxSizeMB">, sourceBytes: number, durationMs: number, keptMs: number): number | null {
  if (settings.mode === TrimMode.ModeFast) {
    if (durationMs <= 0) return null;
    return Math.round(sourceBytes * Math.min(1, keptMs / durationMs));
  }
  if (settings.maxSizeMB > 0) return settings.maxSizeMB * 1024 * 1024;
  return null;
}

export function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** "2 segments · 1:23 total · ≈ 34 MB". */
export function summaryText(segs: readonly Seg[], settings: Pick<TrimmerSettings, "mode" | "maxSizeMB">, sourceBytes: number, durationMs: number): string {
  const kept = totalMs(segs);
  const n = segs.length;
  const est = estimateBytes(settings, sourceBytes, durationMs, kept);
  const size = est === null ? "size depends on the content" : `≈ ${formatSize(est)}`;
  return `${n} ${n === 1 ? "segment" : "segments"} · ${formatClock(kept)} total · ${size}`;
}

/** Why the segments can't be exported, or null. */
export function segmentsError(segs: readonly Seg[], durationMs: number): string | null {
  if (segs.length === 0) return "Add a segment to export";
  for (const s of segs) {
    if (s.endMs - s.startMs < MIN_SEGMENT_MS) return "Every segment must be at least 0.1 s";
    if (s.startMs < 0 || s.endMs > durationMs + 1) return "A segment is outside the file";
  }
  return null;
}

/** Builds the Enqueue options from the editor state. */
export function buildOptions(segs: readonly Seg[], settings: TrimmerSettings, hasVideo: boolean, durationMs: number): TrimmerOptions {
  const sorted: TrimSegment[] = [...segs]
    .sort((a, b) => a.startMs - b.startMs)
    .map((s) => ({ startMs: Math.round(s.startMs), endMs: Math.min(Math.round(s.endMs), Math.round(durationMs)) }));
  return {
    ...settings,
    segments: sorted,
    join: sorted.length >= 2 ? settings.join : TrimJoin.JoinMerge,
    aspect: hasVideo ? settings.aspect : TrimAspect.AspectKeep,
  };
}
