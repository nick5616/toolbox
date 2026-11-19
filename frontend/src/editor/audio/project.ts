/**
 * What the mixer plays for a project (Phase 21 SPEC §B1): a pure function of
 * the document and the sources' states, plus the gain maths the mixer uses.
 */
import type { EditClip } from "@/lib/api";
import type { NormalProject } from "@/viz/edit/defaults";
import { parseEditParam } from "@/viz/edit/schema";
import type { EditParam, Key } from "@/viz/edit/types";
import { evalEditParam } from "@/viz/edit/params";
import { speedAt } from "@/editor/doc";
import type { AudioClipPlan, ProjectAudio, TrackAudio } from "./types";

/** The part of a source's state the audio needs (the full EditSourceState fits). */
export interface AudioSourceInfo {
  info?: { hasAudio?: boolean } | null;
}

/** A speed ramp is cut into steps this long (ms of timeline) and each step plays at one rate. */
export const SPEED_STEP_MS = 100;
/** Rates below this play nothing. */
export const SILENT_RATE = 0.02;
/** The de-click ramp when a clip has no fade (SPEC §B1: 10 ms). */
export const DECLICK_MS = 10;

const parseGain = (raw: string): { base: number; keys: Key[] } => {
  if (!raw) return { base: 0, keys: [] };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { base: 0, keys: [] };
  }
  const p = parseEditParam(v, 0, { min: -60, max: 12, allowMods: false }, "gain", []);
  return typeof p === "number" ? { base: p, keys: [] } : { base: p.base, keys: p.keys ?? [] };
};

/** Constant-speed segments covering [startMs, endMs) of a clip (timeline ms). */
export function speedSegments(clip: Pick<EditClip, "speed" | "startMs" | "endMs">): AudioClipPlan["speed"] {
  const start = clip.startMs;
  const end = clip.endMs;
  const raw = clip.speed;
  if (!raw) return [{ fromMs: start, toMs: end, rate: 1 }];
  let parsed: EditParam;
  try {
    parsed = parseEditParam(JSON.parse(raw), 1, { min: 0, max: 4, allowMods: false }, "speed", []);
  } catch {
    return [{ fromMs: start, toMs: end, rate: 1 }];
  }
  if (typeof parsed === "number") return [{ fromMs: start, toMs: end, rate: parsed }];
  if (!parsed.keys?.length) return [{ fromMs: start, toMs: end, rate: parsed.base }];
  const out: AudioClipPlan["speed"] = [];
  for (let u = 0; start + u < end; u += SPEED_STEP_MS) {
    const to = Math.min(end, start + u + SPEED_STEP_MS);
    const rate = speedAt(clip as EditClip, u + (to - start - u) / 2);
    const last = out[out.length - 1];
    if (last && Math.abs(last.rate - rate) < 0.005) last.toMs = to;
    else out.push({ fromMs: start + u, toMs: to, rate });
  }
  return out;
}

/** Everything the mixer plays: clips with sound, track states and the song. */
export function buildProjectAudio(project: NormalProject, sources: Readonly<Record<string, AudioSourceInfo | undefined>>): ProjectAudio {
  const clips: AudioClipPlan[] = [];
  const tracks: TrackAudio[] = [];
  for (const t of project.tracks) {
    if (t.kind === "adjust") continue;
    const extra = t as { gainDb?: number };
    tracks.push({ trackId: t.id, gainDb: extra.gainDb ?? 0, muted: !!t.muted, solo: !!t.solo });
    for (const c of t.clips) {
      if (c.kind !== "video" && c.kind !== "audio") continue;
      if (!c.path || c.endMs <= c.startMs) continue;
      if (c.kind === "video" && sources[c.path]?.info?.hasAudio === false) continue;
      const g = parseGain(c.gain ?? "");
      clips.push({
        clipId: c.id,
        trackId: t.id,
        path: c.path,
        startMs: c.startMs,
        endMs: c.endMs,
        inMs: c.inMs,
        speed: speedSegments(c),
        volume: Number.isFinite(c.volume) ? Math.max(0, c.volume) : 1,
        gainKeys: g.keys,
        gainBaseDb: g.base,
        fadeInMs: c.fadeInMs ?? 0,
        fadeOutMs: c.fadeOutMs ?? 0,
      });
    }
  }
  const s = project.song;
  return {
    clips,
    tracks,
    song: s && s.path && s.endMs > s.startMs ? { path: s.path, startMs: s.startMs, endMs: s.endMs, gainDb: s.gainDb, fadeInMs: s.fadeInMs, fadeOutMs: s.fadeOutMs } : null,
  };
}

/** The song as one more clip, on the timeline from 0. */
export function songPlan(song: NonNullable<ProjectAudio["song"]>): AudioClipPlan {
  const len = song.endMs - song.startMs;
  return {
    clipId: SONG_ID,
    trackId: "",
    path: song.path,
    startMs: 0,
    endMs: len,
    inMs: song.startMs,
    speed: [{ fromMs: 0, toMs: len, rate: 1 }],
    volume: 1,
    gainKeys: [],
    gainBaseDb: song.gainDb,
    fadeInMs: song.fadeInMs,
    fadeOutMs: song.fadeOutMs,
  };
}
export const SONG_ID = "__song__";

/** The length of an edit in ms: the latest clip end or the song's length, whichever is longer (min 1 s when empty). */
export function audioLengthMs(project: Pick<NormalProject, "song" | "tracks">): number {
  let end = project.song ? Math.max(0, project.song.endMs - project.song.startMs) : 0;
  for (const t of project.tracks) for (const c of t.clips) end = Math.max(end, c.endMs);
  return Math.max(1000, end);
}

/** The linear gain of a clip at timeline time tl: Volume × dB keys × fades. */
export function clipGainAt(plan: AudioClipPlan, tlMs: number): number {
  const u = tlMs - plan.startMs;
  const len = plan.endMs - plan.startMs;
  if (u < 0 || u > len) return 0;
  const param: EditParam = plan.gainKeys.length ? { base: plan.gainBaseDb, keys: plan.gainKeys } : plan.gainBaseDb;
  const db = evalEditParam(param, -60, 12, u, 0, null);
  const fin = plan.fadeInMs > 0 ? plan.fadeInMs : DECLICK_MS;
  const fout = plan.fadeOutMs > 0 ? plan.fadeOutMs : DECLICK_MS;
  const fade = Math.max(0, Math.min(1, u / fin)) * Math.max(0, Math.min(1, (len - u) / fout));
  return plan.volume * 10 ** (db / 20) * fade;
}

/** The gain curve for setValueCurveAtTime over [fromMs, toMs] of timeline time (≥ 2 points, ≤ maxPoints). */
export function gainCurve(plan: AudioClipPlan, fromMs: number, toMs: number, maxPoints = 2048): Float32Array {
  const span = Math.max(0, toMs - fromMs);
  const step = Math.max(DECLICK_MS / 2, span / (maxPoints - 1));
  const n = Math.max(2, Math.min(maxPoints, Math.ceil(span / step) + 1));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = clipGainAt(plan, fromMs + (span * i) / (n - 1));
  return out;
}

/** A track's linear level: 0 when muted or another track is solo; else its dB. */
export function trackLevel(track: TrackAudio, anySolo: boolean): number {
  if (track.muted || (anySolo && !track.solo)) return 0;
  return 10 ** (track.gainDb / 20);
}

/** Source ms at the start of segment i (and the clip's inMs for i = 0). */
export function segmentSourceMs(plan: AudioClipPlan, i: number): number {
  let src = plan.inMs;
  for (let j = 0; j < i; j++) {
    const s = plan.speed[j];
    if (s) src += s.rate * (s.toMs - s.fromMs);
  }
  return src;
}
