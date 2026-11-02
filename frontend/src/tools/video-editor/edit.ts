// Pure document edits for the Video Editor (SPEC.md Part B §B6.1 rules).
import type { VideoClip, VideoClipInfo, VideoMusic, VideoProject, VideoTitle } from "@/lib/api";
import {
  MAX_PHOTO_MS,
  MAX_TOTAL_MS,
  MAX_TRANSITION_MS,
  MIN_CLIP_MS,
  MIN_PHOTO_MS,
  MIN_TRANSITION_MS,
  clipLenMs,
  durationMs,
  speedOf,
  timeline,
} from "./timeline";

export const MAX_CLIPS = 200;
export const MAX_TITLES = 100;
export const MIN_TITLE_MS = 500;
export const SPEEDS = [0.5, 0.75, 1, 1.5, 2] as const;
export const ASPECTS = ["9:16", "4:5", "1:1", "16:9"] as const;

let counter = 0;
/** A unique id for clips and titles. */
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function clipsOf(doc: VideoProject): VideoClip[] {
  return doc.clips ?? [];
}

export function titlesOf(doc: VideoProject): VideoTitle[] {
  return doc.titles ?? [];
}

export function emptyProject(aspect: string): VideoProject {
  return { version: 1, aspect, clips: [], music: null, titles: [], maxSizeMB: 0 };
}

/** The Video Editor's nearest shape for a Post Builder aspect (3:4 -> 4:5, 1.91:1 -> 16:9). */
export function mapPostAspect(aspect: string): string {
  switch (aspect) {
    case "9:16":
    case "4:5":
    case "1:1":
    case "16:9":
      return aspect;
    case "3:4":
      return "4:5";
    case "1.91:1":
      return "16:9";
    default:
      return "9:16";
  }
}

/** The size a probed file is shown at (rotation applied). */
export function displaySize(info: Pick<VideoClipInfo, "width" | "height" | "rotation">): { w: number; h: number } {
  const r = Math.abs(info.rotation || 0) % 180;
  return r === 90 ? { w: info.height, h: info.width } : { w: info.width, h: info.height };
}

/** A new clip from a probed file; null for audio and unreadable files. */
export function clipFromInfo(info: VideoClipInfo, id: string = newId("c")): VideoClip | null {
  if (info.error || (info.kind !== "video" && info.kind !== "image")) return null;
  return {
    id,
    kind: info.kind,
    path: info.path,
    inMs: 0,
    outMs: info.kind === "video" ? Math.max(info.durationMs, MIN_CLIP_MS) : 0,
    durationMs: info.kind === "image" ? 3000 : 0,
    speed: 1,
    volume: 1,
    fit: "fill",
    fitColor: "#000000",
    panX: 0,
    panY: 0,
    zoom: 1,
    motion: info.kind === "image" ? "in" : "none",
    look: "none",
    transition: { kind: "cut", durationMs: 0 },
  };
}

/** Appends probed files as clips (alternating photo motion). */
export function appendClips(doc: VideoProject, infos: readonly VideoClipInfo[]): { doc: VideoProject; added: number } {
  const clips = [...clipsOf(doc)];
  let added = 0;
  for (const info of infos) {
    if (clips.length >= MAX_CLIPS) break;
    const c = clipFromInfo(info);
    if (!c) continue;
    if (c.kind === "image") c.motion = clips.filter((x) => x.kind === "image").length % 2 === 0 ? "in" : "out";
    clips.push(c);
    added++;
  }
  return { doc: fixTransitions({ ...doc, clips }), added };
}

/** Clamps every transition to what the neighbours allow; one that can't fit becomes a cut. */
export function fixTransitions(doc: VideoProject): VideoProject {
  const clips = clipsOf(doc);
  let changed = false;
  const next = clips.map((c, i) => {
    const t = c.transition;
    if (!t || t.kind === "cut") return c;
    const nb = clips[i + 1];
    if (!nb) return c;
    const limit = Math.min(MAX_TRANSITION_MS, Math.floor(clipLenMs(c) / 2), Math.floor(clipLenMs(nb) / 2));
    const d = Math.min(Math.max(t.durationMs, MIN_TRANSITION_MS), limit);
    if (limit < MIN_TRANSITION_MS) {
      changed = true;
      return { ...c, transition: { kind: "cut", durationMs: 0 } };
    }
    if (d === t.durationMs) return c;
    changed = true;
    return { ...c, transition: { ...t, durationMs: d } };
  });
  return changed ? { ...doc, clips: next } : doc;
}

/** Replaces one clip and re-validates the transitions. */
export function updateClip(doc: VideoProject, index: number, patch: Partial<VideoClip>): VideoProject {
  const clips = clipsOf(doc);
  const c = clips[index];
  if (!c) return doc;
  const next = clips.slice();
  next[index] = { ...c, ...patch };
  return fixTransitions({ ...doc, clips: next });
}

/** Sets a join's transition. The last clip has none. */
export function setTransition(doc: VideoProject, index: number, kind: string, durationMs: number): VideoProject {
  const clips = clipsOf(doc);
  if (index < 0 || index >= clips.length - 1) return doc;
  const t = kind === "cut" ? { kind: "cut", durationMs: 0 } : { kind, durationMs: Math.min(Math.max(durationMs, MIN_TRANSITION_MS), MAX_TRANSITION_MS) };
  return updateClip(doc, index, { transition: t });
}

/** Moves a clip to a new position (its outgoing transition goes with it). */
export function moveClip(doc: VideoProject, from: number, to: number): VideoProject {
  const clips = clipsOf(doc);
  if (from === to || from < 0 || from >= clips.length) return doc;
  const dest = Math.min(Math.max(to, 0), clips.length - 1);
  if (dest === from) return doc;
  const next = clips.slice();
  const [c] = next.splice(from, 1);
  if (!c) return doc;
  next.splice(dest, 0, c);
  return fixTransitions({ ...doc, clips: next });
}

export function deleteClip(doc: VideoProject, index: number): VideoProject {
  const clips = clipsOf(doc);
  if (index < 0 || index >= clips.length) return doc;
  return fixTransitions({ ...doc, clips: clips.filter((_, i) => i !== index) });
}

/**
 * Moves a clip edge by deltaMs of timeline time (a trim). Video: In/Out move
 * by delta x speed, kept inside the source (sourceDurMs, 0 = unknown) and at
 * least 0.3 s long after speed. Photos: the duration changes (1-10 s).
 */
export function trimClip(
  doc: VideoProject,
  index: number,
  edge: "start" | "end",
  deltaMs: number,
  sourceDurMs = 0,
): VideoProject {
  const c = clipsOf(doc)[index];
  if (!c) return doc;
  if (c.kind === "image") {
    const d = c.durationMs + (edge === "end" ? deltaMs : -deltaMs);
    return updateClip(doc, index, { durationMs: Math.round(Math.min(Math.max(d, MIN_PHOTO_MS), MAX_PHOTO_MS)) });
  }
  const sp = speedOf(c);
  const minSrc = Math.ceil(MIN_CLIP_MS * sp);
  if (edge === "start") {
    const inMs = Math.round(Math.min(Math.max(c.inMs + deltaMs * sp, 0), c.outMs - minSrc));
    return updateClip(doc, index, { inMs });
  }
  const maxOut = sourceDurMs > 0 ? sourceDurMs : Number.POSITIVE_INFINITY;
  const outMs = Math.round(Math.min(Math.max(c.outMs + deltaMs * sp, c.inMs + minSrc), maxOut));
  return updateClip(doc, index, { outMs });
}

/** Sets a video clip's In/Out directly (the inspector's trim control). */
export function setClipRange(doc: VideoProject, index: number, inMs: number, outMs: number): VideoProject {
  const c = clipsOf(doc)[index];
  if (!c || c.kind !== "video") return doc;
  const minSrc = Math.ceil(MIN_CLIP_MS * speedOf(c));
  const i = Math.max(0, Math.round(inMs));
  const o = Math.max(i + minSrc, Math.round(outMs));
  return updateClip(doc, index, { inMs: i, outMs: o });
}

/**
 * Splits the clip at timeline time tMs into two (In/Out split for video, a
 * shorter and a new photo clip otherwise). Null when either half would be too
 * short. The first half gets a cut; the second keeps the original transition.
 */
export function splitClip(doc: VideoProject, index: number, tMs: number, id: string = newId("c")): VideoProject | null {
  const clips = clipsOf(doc);
  const c = clips[index];
  const span = timeline(clips)[index];
  if (!c || !span) return null;
  const local = Math.round(tMs - span.startMs);
  const min = c.kind === "image" ? MIN_PHOTO_MS : MIN_CLIP_MS;
  if (local < min || span.lenMs - local < min || clips.length >= MAX_CLIPS) return null;
  let first: VideoClip;
  let second: VideoClip;
  if (c.kind === "image") {
    first = { ...c, durationMs: local, transition: { kind: "cut", durationMs: 0 } };
    second = { ...c, id, durationMs: c.durationMs - local, motion: c.motion === "none" ? "none" : "in" };
  } else {
    const at = Math.round(c.inMs + local * speedOf(c));
    first = { ...c, outMs: at, transition: { kind: "cut", durationMs: 0 } };
    second = { ...c, id, inMs: at };
  }
  const next = clips.slice();
  next.splice(index, 1, first, second);
  return fixTransitions({ ...doc, clips: next });
}

// --- music -----------------------------------------------------------------

export function defaultMusic(path: string): VideoMusic {
  return { path, offsetMs: 0, volume: 0.8, fadeInMs: 500, fadeOutMs: 1500, duck: true, endWithMusic: false };
}

// --- titles ----------------------------------------------------------------

export function newTitle(startMs: number, durationMs = 3000): VideoTitle {
  return {
    id: newId("t"),
    text: "Title",
    startMs: Math.max(0, Math.round(startMs)),
    durationMs,
    style: "title",
    position: "center",
    font: "",
    color: "#ffffff",
  };
}

export function updateTitle(doc: VideoProject, id: string, patch: Partial<VideoTitle>): VideoProject {
  const titles = titlesOf(doc);
  if (!titles.some((t) => t.id === id)) return doc;
  return {
    ...doc,
    titles: titles.map((t) => {
      if (t.id !== id) return t;
      const n = { ...t, ...patch };
      n.startMs = Math.max(0, Math.round(n.startMs));
      n.durationMs = Math.max(MIN_TITLE_MS, Math.round(n.durationMs));
      return n;
    }),
  };
}

export function deleteTitle(doc: VideoProject, id: string): VideoProject {
  return { ...doc, titles: titlesOf(doc).filter((t) => t.id !== id) };
}

// --- checks ----------------------------------------------------------------

/** Local checks that explain why an export would fail, shown next to the header. */
export function localWarnings(doc: VideoProject, missingPaths: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const clips = clipsOf(doc);
  if (clips.length === 0) out.push("Add at least one clip");
  const missing = clips.filter((c) => missingPaths.has(c.path)).length;
  if (missing > 0) out.push(missing === 1 ? "A clip's file is missing" : `${missing} clips' files are missing`);
  if (doc.music && missingPaths.has(doc.music.path)) out.push("The song is missing");
  if (durationMs(clips) > MAX_TOTAL_MS) out.push("The video can be at most 30 minutes long");
  if (doc.music && !doc.music.path) out.push("Pick a song");
  const total = durationMs(clips);
  const late = titlesOf(doc).filter((t) => t.startMs >= total).length;
  if (clips.length > 0 && late > 0) out.push(late === 1 ? "A title starts after the video ends" : `${late} titles start after the video ends`);
  return out;
}
