/**
 * Range maths for Setup and "Change range…" (SPEC §14.2): clamping, snapping
 * to downbeats, quick picks, and "Keep clips on the music".
 */
import type { EditClip } from "@/lib/api";
import type { Analysis } from "@/viz/analysis";
import type { NormalProject } from "@/viz/edit/defaults";
import { interpolateKeys } from "@/viz/edit/params";
import { parseSpeed, parseTransform, serializeSpeed, serializeTransform } from "@/viz/edit/schema";
import type { ClipTransform, EditParam, Key, SongRange } from "@/viz/edit/types";
import { speedAt } from "@/editor/doc";

/** 1 s ≤ D ≤ 10 min (§4). */
export const MIN_RANGE_MS = 1000;
export const MAX_RANGE_MS = 600_000;

/** Fits a range into [0, durationMs] with a length of 1 s .. 10 min (the end moves first). */
export function clampRange(r: SongRange, durationMs: number): SongRange {
  const dur = Math.max(0, Math.round(durationMs));
  let start = Math.max(0, Math.min(Math.round(r.startMs), Math.max(0, dur - MIN_RANGE_MS)));
  let end = Math.round(r.endMs);
  end = Math.max(start + MIN_RANGE_MS, Math.min(end, dur, start + MAX_RANGE_MS));
  if (end > dur) {
    end = dur;
    start = Math.max(0, Math.min(start, end - MIN_RANGE_MS));
  }
  return { startMs: start, endMs: end };
}

/** The nearest value in a sorted list (ms itself when the list is empty). */
export function nearestOf(sorted: readonly number[], ms: number): number {
  if (!sorted.length) return ms;
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) < ms) lo = mid + 1;
    else hi = mid;
  }
  const a = sorted[lo] as number;
  const b = sorted[lo - 1];
  return b !== undefined && ms - b <= a - ms ? b : a;
}

/** Snaps one or both edges to downbeats (unless the caller skips it) and clamps. */
export function snapRange(r: SongRange, downbeats: readonly number[], edge: "start" | "end" | "both", durationMs: number): SongRange {
  const snapped = { startMs: edge === "end" ? r.startMs : nearestOf(downbeats, r.startMs), endMs: edge === "start" ? r.endMs : nearestOf(downbeats, r.endMs) };
  return clampRange(snapped, durationMs);
}

export interface QuickPick {
  id: "whole" | "first-chorus" | "last-chorus" | "drop" | "30s" | "15s";
  label: string;
  /** null when the song has no such part. */
  range: SongRange | null;
}

/** The quick picks for an analysis, given the current range ("from here" = its start). */
export function quickPicks(a: Analysis, current: SongRange): QuickPick[] {
  const dur = a.durationMs;
  const sections = a.audio.sections;
  const section = (label: string, last: boolean): SongRange | null => {
    const list = sections.filter((s) => s.label === label && s.endMs - s.startMs >= MIN_RANGE_MS);
    const s = last ? list[list.length - 1] : list[0];
    return s ? clampRange({ startMs: s.startMs, endMs: s.endMs }, dur) : null;
  };
  const from = (len: number): SongRange | null => {
    if (dur < MIN_RANGE_MS) return null;
    const start = Math.max(0, Math.min(current.startMs, dur - Math.min(len, dur)));
    return clampRange({ startMs: start, endMs: start + len }, dur);
  };
  return [
    { id: "whole", label: "Whole song", range: dur >= MIN_RANGE_MS ? clampRange({ startMs: 0, endMs: dur }, dur) : null },
    { id: "first-chorus", label: "First chorus", range: section("chorus", false) },
    { id: "last-chorus", label: "Last chorus", range: section("chorus", true) },
    { id: "drop", label: "Drop", range: section("drop", false) },
    { id: "30s", label: "30 s from here", range: from(30_000) },
    { id: "15s", label: "15 s from here", range: from(15_000) },
  ];
}

// ---- keeping clips on the music ----

/** A param with its keys moved earlier by `cut` ms (the first kept key holds the value at the cut). */
export function trimParamStart(p: EditParam, cut: number): EditParam {
  if (typeof p === "number" || !p.keys || p.keys.length === 0 || cut <= 0) return p;
  const keys = p.keys;
  const v0 = interpolateKeys(keys, cut);
  const idx = keys.findIndex((k) => k.t > cut);
  const first = (idx <= 0 ? keys[idx < 0 ? keys.length - 1 : 0] : keys[idx - 1]) as Key;
  const rest = idx < 0 ? [] : keys.slice(idx).map((k) => ({ ...k, t: k.t - cut }));
  return { ...p, keys: [{ t: 0, v: v0, ease: first.ease }, ...rest] };
}

function trimTransform(raw: string, cut: number): string {
  if (!raw) return raw;
  const t = parseTransform(raw).value;
  const next: ClipTransform = {
    x: trimParamStart(t.x, cut),
    y: trimParamStart(t.y, cut),
    scale: trimParamStart(t.scale, cut),
    rotation: trimParamStart(t.rotation, cut),
    opacity: trimParamStart(t.opacity, cut),
  };
  return serializeTransform(next);
}

/** Source ms a video clip consumes over its first `cutMs` of timeline (speed integrated on the 1 ms grid of `step`). */
function sourceOver(clip: EditClip, cutMs: number, fps: number): number {
  const step = 1000 / fps;
  let src = 0;
  for (let u = 0; u < cutMs; u += step) src += speedAt(clip, u) * Math.min(step, cutMs - u);
  return src;
}

export interface ShiftResult {
  project: NormalProject;
  removed: number;
  trimmed: number;
}

/**
 * Moves every clip by −delta (delta = new range start − old range start) so it
 * stays on the same music. Clips ending at or before 0 are removed (so are
 * clips left under one frame), clips starting before 0 are trimmed at the
 * front: a video clip's `inMs` advances by the source it skipped, and the
 * transform and speed keyframes move with it.
 */
export function shiftClips(p: NormalProject, delta: number): ShiftResult {
  if (delta === 0) return { project: p, removed: 0, trimmed: 0 };
  const frame = 1000 / Math.max(1, p.fps);
  let removed = 0;
  let trimmed = 0;
  const tracks = p.tracks.map((t) => {
    const clips: EditClip[] = [];
    for (const c of t.clips) {
      const start = c.startMs - delta;
      const end = c.endMs - delta;
      if (end <= 0 || (start < 0 && end < frame)) {
        removed++;
        continue;
      }
      if (start >= 0) {
        clips.push({ ...c, startMs: start, endMs: end });
        continue;
      }
      const cut = -start;
      trimmed++;
      const next: EditClip = { ...c, startMs: 0, endMs: end, auto: false };
      if (c.kind === "video") next.inMs = Math.round(c.inMs + sourceOver(c, cut, p.fps));
      next.transform = trimTransform(c.transform, cut);
      if (c.speed) {
        const sp = parseSpeed(c.speed).value;
        next.speed = serializeSpeed(trimParamStart(sp, cut));
      }
      clips.push(next);
    }
    return { ...t, clips };
  });
  return { project: { ...p, tracks }, removed, trimmed };
}

/** The project with a new song range; clips follow the music when `keepClips` is on. */
export function changeRange(p: NormalProject, r: SongRange, keepClips: boolean): ShiftResult {
  if (!p.song) return { project: p, removed: 0, trimmed: 0 };
  if (p.song.startMs === r.startMs && p.song.endMs === r.endMs) return { project: p, removed: 0, trimmed: 0 };
  const shifted = keepClips ? shiftClips(p, r.startMs - p.song.startMs) : { project: p, removed: 0, trimmed: 0 };
  return { ...shifted, project: { ...shifted.project, song: { ...p.song, startMs: r.startMs, endMs: r.endMs } } };
}
