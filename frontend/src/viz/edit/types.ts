/**
 * Edit Studio's frontend contracts (Phase 9 SPEC §5.1, §6.3, §8.1).
 *
 * CONTRACT (Wave 0): frozen. The Go document (EditProject and friends) comes
 * from the bindings; the JSON-in-string fields of that document hold the
 * shapes below and are parsed by ./schema.ts. Nothing here may import
 * runtime code from @/lib/api (the export worker loads this file): type
 * imports only.
 */
import type { EditProject } from "@/lib/api";
import type { Analysis } from "../analysis";
import type { Mod, PostType, SectionLabel, SignalId, TransitionKind } from "../types";
import type { FrameKey, FrameProvider, StreamRef } from "../frames/types";

export type { EditProject };

// ---- markers (§5) ----

export const MARKER_LANES = [
  "beat", "downbeat", "kick", "snare", "hats", "bass", "vocals", "other",
  "section", "drop", "lift", "break", "stop", "phrase", "word", "custom",
  // Part C: stand-out moments of the song (accents, fills, hits that don't repeat).
  "accent",
] as const;
export type MarkerLane = (typeof MARKER_LANES)[number];

export interface Marker {
  /** "<lane>:<songMs>" (derived, before nudge/move) | a custom marker's id. */
  id: string;
  lane: MarkerLane;
  /** Timeline ms, after nudge and overrides. */
  ms: number;
  /** Timeline ms: section, stop, phrase, word. */
  endMs?: number;
  /** 0..1 */
  strength: number;
  /** Section label (or renamed), word text, custom note. */
  label?: string;
  /** Index into audio.beats (beat, downbeat). */
  beatIndex?: number;
  /** 0-based bar index; −1 before the first downbeat. */
  bar?: number;
  /** An override moved it. */
  moved?: boolean;
}

/** Mirrors Go LaneSettings. */
export interface LaneSettings {
  visible: boolean;
  minStrength: number; // 0..1
  every: number; // 1..16
  firstOfBar: boolean;
  nudgeMs: number; // −200..200
}

/** The song range a project uses, in song ms. */
export interface SongRange {
  startMs: number;
  endMs: number;
}

// ---- effects and params (§6.3) ----

export type MarkerSignalId = `marker.${MarkerLane}`;
export type EditSignalId = SignalId | MarkerSignalId;

export interface EditMod extends Omit<Mod, "signal"> {
  signal: EditSignalId;
  /** 1..16, marker signals only. */
  every?: number;
  /** Gate: only inside these sections (any signal). */
  sections?: SectionLabel[];
}

/** A keyframe; t is clip-relative ms. */
export interface Key {
  t: number;
  v: number;
  ease: "linear" | "ease" | "hold";
}

/** A number, or a base with keyframes (≤ 64) and signal mods (≤ 4). */
export type EditParam = number | { base: number; keys?: Key[]; mods?: EditMod[] };

/** A post effect with EditParams (PostConfig's shape). */
export interface EditPost {
  id: string;
  type: PostType;
  enabled: boolean;
  params: Record<string, EditParam | string | boolean>;
}

export interface ClipTransform {
  x: EditParam; // offset, fraction of frame width (−2..2), 0
  y: EditParam; // offset, fraction of frame height (−2..2), 0
  scale: EditParam; // × the fitted size (0.05..8), 1
  rotation: EditParam; // degrees (−3600..3600), 0
  opacity: EditParam; // 0..1, 1
  /** Part B: what shows where a moved/zoomed clip leaves the frame: nothing (default) or the picture mirrored (motion tile). */
  edges?: "clear" | "mirror";
}

// ---- Part B: generated clips, blend modes, track mattes ----

export const BLEND_MODES = ["normal", "add", "screen", "multiply", "overlay", "softlight", "hardlight", "difference", "exclusion", "lighten", "darken", "colordodge"] as const;
export type EditBlendMode = (typeof BLEND_MODES)[number];

export const TRACK_MATTES = ["", "alpha", "alpha-inverted", "luma", "luma-inverted"] as const;
export type TrackMatte = (typeof TRACK_MATTES)[number];

/** Clip.Text JSON (kind "text"). */
export interface TextClip {
  /** 1..500 characters; line breaks allowed. */
  text: string;
  /** The captions' style (its preset animates the words: pop, rise, typewriter, wave…). */
  style: import("../types").TextStyle;
  /** "all": the whole text at once; "words": words appear one after another over `wordMs` each; "beats": one word per marker of `lane`. */
  reveal: "all" | "words" | "beats";
  /** "words": ms per word (40..2000). */
  wordMs: number;
  /** "beats": the marker lane words land on, every Nth. */
  lane: MarkerLane;
  every: number; // 1..16
}

/** Clip.Visual JSON (kind "visual"): a Visualizer layer drawn as a clip, reacting to the song. */
export interface VisualClip {
  layer: import("../types").LayerType;
  /** Partial layer params (defaults fill the rest); numbers may be EditParams (keys/mods). */
  params: Record<string, EditParam | string | boolean>;
  palette: import("../types").PaletteId;
}

export interface Mask {
  id: string;
  shape: "rect" | "ellipse" | "path";
  x: EditParam; // centre, 0..1 of the clip's drawn rect
  y: EditParam;
  w: EditParam; // 0..2 of the drawn rect (rect/ellipse); path: scale x
  h: EditParam; // path: scale y
  rotation: EditParam; // degrees
  points?: Array<[number, number]>; // path: 3..32 points, 0..1 of the drawn rect, closed
  smooth?: boolean; // path: Catmull-Rom through the points
  feather: number; // 0..0.5 of the drawn rect's short side
  invert: boolean;
  op: "add" | "subtract" | "intersect";
}

export interface EditTransition {
  kind: TransitionKind;
  ms: number; // 0..2000; "cut" ignores ms
}

// ---- rendering (§8.1) ----

/**
 * Files the engine may read, as /media URLs. Stream keys: "v:<path>" a video's
 * edit stream, "m:<matteId>" a video matte, "i:<path>|<fromS>-<toS>" an
 * interp stream. Image keys: "p:<path>" a photo, "m:<matteId>" an image matte.
 */
export interface EditFiles {
  streams: Record<string, StreamRef>;
  images: Record<string, string>;
}

export interface EditInputs {
  project: EditProject;
  /** The song's analysis (captions use analysis.withText when Captions.lines is set). */
  analysis: Analysis;
  /** deriveMarkers(...) for the project's range. */
  markers: Marker[];
  files: EditFiles;
}

export interface EditEngineOptions {
  width: number;
  height: number;
  fps: number;
  seed: number;
  quality: "full" | "draft";
  inWorker: boolean;
}

/**
 * The result of compileEdit (WP-ES3 owns its internals and may add fields).
 * Everyone else reads only the fields below.
 */
export interface CompiledEdit {
  /** D in ms (§4). */
  durationMs: number;
  /** round(D·fps/1000). */
  frames: number;
  fps: number;
  /** Invalid JSON fields that fell back to defaults, for the UI ("tracks[0].clips[2].effects: …"). */
  problems: string[];
}

export type { FrameKey, FrameProvider, StreamRef };

// ---- small shared helpers ----

export const ASPECTS = ["9:16", "4:5", "1:1", "16:9"] as const;
export type Aspect = (typeof ASPECTS)[number];

/** Output size for an aspect at a short side (even numbers). */
export function sizeFor(aspect: string, short: number): { width: number; height: number } {
  const even = (n: number) => Math.round(n / 2) * 2;
  switch (aspect) {
    case "9:16":
      return { width: short, height: even((short * 16) / 9) };
    case "4:5":
      return { width: short, height: even((short * 5) / 4) };
    case "16:9":
      return { width: even((short * 16) / 9), height: short };
    default:
      return { width: short, height: short };
  }
}

/** The preview canvas size (§14.3): short side 540. */
export function previewSize(aspect: string): { width: number; height: number } {
  return sizeFor(aspect, 540);
}

/** D (§4): the song range's length, 0 without a song. */
export function editLength(p: Pick<EditProject, "song">): number {
  return p.song ? Math.max(0, p.song.endMs - p.song.startMs) : 0;
}
