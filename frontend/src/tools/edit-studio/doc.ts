/**
 * Edit Studio document helpers (Phase 9 SPEC §14.12; Wave 0, frozen API).
 * Pure: every function returns a new project (or the same one when nothing
 * changed). Timeline edit operations live in timeline/ops.ts (WP-ES2).
 */
import type { EditClip, EditTrack } from "@/lib/api";
import { emptyEditProject, normalizeProject, type NormalProject } from "@/viz/edit/defaults";
import { interpolateKeys } from "@/viz/edit/params";
import { parseSpeed } from "@/viz/edit/schema";

export { emptyEditProject, normalizeProject };
export type { NormalProject };

let idCounter = 0;
/** A short unique ID ([A-Za-z0-9_-], ≤ 40 chars) with a prefix: "c" clips, "t" tracks, "m" mattes, "k" custom markers, "fx" effects. */
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_000_000;
  const rnd = Math.floor(Math.random() * 0x1000000).toString(36);
  return `${prefix}${Date.now().toString(36)}${rnd}${idCounter.toString(36)}`.slice(0, 40);
}

/** A clip with every field set (defaults for the rest). */
export function newClip(over: Partial<EditClip> & Pick<EditClip, "kind" | "startMs" | "endMs">): EditClip {
  return {
    id: newId("c"),
    path: "",
    color: "",
    inMs: 0,
    speed: "",
    slow: "",
    volume: 0,
    fit: "fill",
    fitColor: "#000000",
    flipX: false,
    blend: "normal",
    transform: "",
    matte: null,
    fxTarget: "clip",
    masks: "",
    effects: "",
    in: "",
    pinned: false,
    auto: false,
    ...over,
  };
}

export function newTrack(kind: "video" | "adjust", name: string): EditTrack {
  return { id: newId("t"), kind, name, muted: false, locked: false, clips: [] };
}

export interface ClipRef {
  track: EditTrack;
  trackIndex: number;
  clip: EditClip;
  clipIndex: number;
}

/** Finds a clip by ID. */
export function findClip(p: NormalProject, id: string): ClipRef | null {
  for (const [trackIndex, track] of p.tracks.entries()) {
    const clipIndex = track.clips.findIndex((c) => c.id === id);
    if (clipIndex >= 0) return { track, trackIndex, clip: track.clips[clipIndex] as EditClip, clipIndex };
  }
  return null;
}

/** All clips with their track, bottom track first. */
export function allClips(p: NormalProject): ClipRef[] {
  return p.tracks.flatMap((track, trackIndex) => track.clips.map((clip, clipIndex) => ({ track, trackIndex, clip, clipIndex })));
}

/**
 * Patches one clip. Any edit to an auto-fill clip makes it the user's (§13.2):
 * `auto` is cleared unless the patch sets it.
 */
export function withClip(p: NormalProject, id: string, patch: Partial<EditClip>): NormalProject {
  let changed = false;
  const tracks = p.tracks.map((t) => {
    const i = t.clips.findIndex((c) => c.id === id);
    if (i < 0) return t;
    const cur = t.clips[i] as EditClip;
    const next: EditClip = { ...cur, ...patch };
    if (!("auto" in patch)) next.auto = false;
    changed = true;
    const clips = t.clips.slice();
    clips[i] = next;
    return { ...t, clips };
  });
  return changed ? { ...p, tracks } : p;
}

/** Patches one track. */
export function withTrack(p: NormalProject, id: string, patch: Partial<EditTrack>): NormalProject {
  const i = p.tracks.findIndex((t) => t.id === id);
  if (i < 0) return p;
  const tracks = p.tracks.slice();
  tracks[i] = { ...(tracks[i] as EditTrack), ...patch } as NormalProject["tracks"][number];
  return { ...p, tracks };
}

/** Clip speed at clip time u (keys only; 1 when unset). */
export function speedAt(clip: EditClip, u: number): number {
  const s = parseSpeed(clip.speed).value;
  if (typeof s === "number") return s;
  return s.keys?.length ? interpolateKeys(s.keys, u) : s.base;
}

/**
 * The source range a video clip plays: [inMs, inMs + ∫ speed], integrated on
 * the output frame grid like compileEdit (§8.3). Used for matte and interp ranges.
 */
export function clipSourceSpan(clip: EditClip, fps: number): { fromMs: number; toMs: number } {
  const step = 1000 / fps;
  const len = clip.endMs - clip.startMs;
  let src = clip.inMs;
  for (let u = 0; u < len; u += step) src += speedAt(clip, u) * Math.min(step, len - u);
  return { fromMs: clip.inMs, toMs: Math.round(src) };
}

/** The file paths a project uses (song, clips, sources), deduplicated. */
export function projectPaths(p: NormalProject): string[] {
  const out = new Set<string>();
  if (p.song?.path) out.add(p.song.path);
  for (const t of p.tracks) for (const c of t.clips) if (c.path) out.add(c.path);
  for (const s of p.sources) out.add(s.path);
  return [...out];
}
