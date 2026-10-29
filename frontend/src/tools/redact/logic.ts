import { RedactAction, RedactSensitivity, RedactStyle, type RedactBox, type RedactOptions, type RedactResult, type RedactTrack, type TimedBox } from "@/lib/api";
import type { Box as OverlayBox } from "@/components/media";

// ---- file kinds ----

const VIDEO_EXT = [".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".wmv", ".flv", ".mpg", ".mpeg", ".ts", ".mts", ".m2ts", ".3gp"];
const lower = (p: string) => p.toLowerCase();

export function isVideoPath(path: string): boolean {
  return VIDEO_EXT.some((e) => lower(path).endsWith(e));
}

export function isHeicPath(path: string): boolean {
  return lower(path).endsWith(".heic") || lower(path).endsWith(".heif");
}

/** TIFF can't be shown by the webview: Go decodes a bounded preview. */
export function isTiffPath(path: string): boolean {
  return lower(path).endsWith(".tif") || lower(path).endsWith(".tiff");
}

export function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

export interface Classified {
  images: string[];
  videos: string[];
}

export function classify(paths: readonly string[]): Classified {
  const out: Classified = { images: [], videos: [] };
  for (const p of paths) (isVideoPath(p) ? out.videos : out.images).push(p);
  return out;
}

// ---- remembered settings ----

export interface RedactSettings {
  faces: boolean;
  plates: boolean;
  sensitivity: RedactOptions["sensitivity"];
  style: RedactOptions["style"];
  strength: number;
  padding: number;
  stripMetadata: boolean;
}

export const DEFAULT_SETTINGS: RedactSettings = {
  faces: true,
  plates: true,
  sensitivity: RedactSensitivity.SensitivityNormal,
  style: RedactStyle.StyleBlur,
  strength: 6,
  padding: 15,
  stripMetadata: true,
};

const clampInt = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

/** `sanitize` for useModuleOptions. */
export function sanitizeSettings(raw: unknown, defaults: RedactSettings): RedactSettings {
  const out = { ...defaults };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.faces === "boolean") out.faces = r.faces;
  if (typeof r.plates === "boolean") out.plates = r.plates;
  if (typeof r.stripMetadata === "boolean") out.stripMetadata = r.stripMetadata;
  if (r.sensitivity === RedactSensitivity.SensitivityNormal || r.sensitivity === RedactSensitivity.SensitivityHigh) out.sensitivity = r.sensitivity;
  if (r.style === RedactStyle.StyleBlur || r.style === RedactStyle.StylePixelate || r.style === RedactStyle.StyleSolid) out.style = r.style;
  out.strength = clampInt(r.strength, 1, 10, defaults.strength);
  out.padding = clampInt(r.padding, 0, 50, defaults.padding);
  return out;
}

/** Full Go options for a job; the edit maps are only filled for apply. */
export function baseOptions(s: RedactSettings, action: RedactOptions["action"]): RedactOptions {
  return {
    action,
    faces: s.faces,
    plates: s.plates,
    sensitivity: s.sensitivity,
    style: s.style,
    strength: s.strength,
    padding: s.padding,
    stripMetadata: s.stripMetadata,
    imageBoxes: {},
    detectionsPath: "",
    disabledTracks: [],
    manualBoxes: [],
  };
}

// ---- results ----

export function parseResult(json: string): RedactResult | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as RedactResult;
    return r && typeof r === "object" ? r : null;
  } catch {
    return null;
  }
}

// ---- image boxes ----

export type ImageBox = RedactBox;

export function toOverlay(b: ImageBox): OverlayBox {
  const kind = b.kind === "face" || b.kind === "plate" ? b.kind : "manual";
  const label = kind === "manual" ? "Manual" : `${kind === "face" ? "Face" : "Plate"} ${Math.round(b.score * 100)}%`;
  return { id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, kind, enabled: b.enabled, label };
}

/** Maps the overlay's edited boxes back onto ours (keeps scores; new boxes are manual). */
export function fromOverlay(prev: readonly ImageBox[], next: readonly OverlayBox[]): ImageBox[] {
  const byId = new Map(prev.map((b) => [b.id, b]));
  return next.map((o) => {
    const old = byId.get(o.id);
    return { id: o.id, x: o.x, y: o.y, w: o.w, h: o.h, kind: old?.kind ?? "manual", enabled: o.enabled, score: old?.score ?? 1 };
  });
}

export function toggleBox(boxes: readonly ImageBox[], id: string): ImageBox[] {
  return boxes.map((b) => (b.id === id ? { ...b, enabled: !b.enabled } : b));
}

export function removeBox(boxes: readonly ImageBox[], id: string): ImageBox[] {
  return boxes.filter((b) => b.id !== id);
}

export function setAllBoxes(boxes: readonly ImageBox[], enabled: boolean): ImageBox[] {
  return boxes.map((b) => ({ ...b, enabled }));
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 faces · 1 plate" (enabled boxes only); "Nothing to hide" when empty. */
export function countLabel(boxes: readonly ImageBox[]): string {
  let faces = 0;
  let plates = 0;
  let manual = 0;
  for (const b of boxes) {
    if (!b.enabled) continue;
    if (b.kind === "face") faces++;
    else if (b.kind === "plate") plates++;
    else manual++;
  }
  const parts: string[] = [];
  if (faces) parts.push(plural(faces, "face", "faces"));
  if (plates) parts.push(plural(plates, "plate", "plates"));
  if (manual) parts.push(plural(manual, "manual box", "manual boxes"));
  return parts.length ? parts.join(" · ") : "Nothing to hide";
}

export function enabledCount(boxes: readonly ImageBox[]): number {
  return boxes.filter((b) => b.enabled).length;
}

export interface ImageEntry {
  path: string;
  width: number;
  height: number;
  boxes: ImageBox[];
}

/** Detect result -> editable entries, in input order. */
export function imageEntries(res: RedactResult | null): ImageEntry[] {
  return (res?.images ?? []).map((i) => ({ path: i.path, width: i.width, height: i.height, boxes: (i.boxes ?? []).map((b) => ({ ...b })) }));
}

/** Options for applying the current edits to every image (all paths need an entry). */
export function imageApplyOptions(s: RedactSettings, paths: readonly string[], edits: Readonly<Record<string, readonly ImageBox[]>>): RedactOptions {
  const imageBoxes: Record<string, ImageBox[]> = {};
  for (const p of paths) imageBoxes[p] = (edits[p] ?? []).map((b) => ({ ...b }));
  return { ...baseOptions(s, RedactAction.ActionApply), imageBoxes };
}

// ---- video tracks ----

export interface VideoState {
  /** Track id -> enabled. */
  tracks: Record<string, boolean>;
  manual: TimedBox[];
}

export const MANUAL_MS = 3000;

export function initialVideoState(tracks: readonly RedactTrack[]): VideoState {
  const map: Record<string, boolean> = {};
  for (const t of tracks) map[t.id] = t.enabled;
  return { tracks: map, manual: [] };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The track's box at `ms` (linear between 200 ms samples); null outside its span. */
export function sampleAt(track: RedactTrack, ms: number): Rect | null {
  const s = track.samples ?? [];
  const first = s[0];
  const last = s[s.length - 1];
  if (!first || !last || ms < track.startMs || ms > track.endMs) return null;
  if (ms <= first.ms) return { x: first.x, y: first.y, w: first.w, h: first.h };
  if (ms >= last.ms) return { x: last.x, y: last.y, w: last.w, h: last.h };
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((s[mid]?.ms ?? 0) <= ms) lo = mid;
    else hi = mid;
  }
  const a = s[lo];
  const b = s[hi];
  if (!a || !b) return null;
  const f = b.ms === a.ms ? 0 : (ms - a.ms) / (b.ms - a.ms);
  const mix = (p: number, q: number) => p + (q - p) * f;
  return { x: mix(a.x, b.x), y: mix(a.y, b.y), w: mix(a.w, b.w), h: mix(a.h, b.h) };
}

export function manualActive(b: TimedBox, ms: number): boolean {
  return ms >= b.startMs && ms <= b.endMs;
}

/** Overlay boxes at `ms`: tracks (id = track id) then manual boxes. */
export function overlayAt(tracks: readonly RedactTrack[], state: VideoState, ms: number): OverlayBox[] {
  const out: OverlayBox[] = [];
  for (const t of tracks) {
    const r = sampleAt(t, ms);
    if (!r) continue;
    const kind = t.kind === "plate" ? "plate" : "face";
    out.push({ id: t.id, ...r, kind, enabled: state.tracks[t.id] ?? t.enabled, label: kind === "face" ? "Face" : "Plate" });
  }
  for (const b of state.manual) {
    if (manualActive(b, ms)) out.push({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, kind: "manual", enabled: b.enabled, label: "Manual" });
  }
  return out;
}

export function newTimedBox(o: OverlayBox, ms: number, durationMs: number): TimedBox {
  const start = Math.max(0, Math.round(ms));
  const end = durationMs > 0 ? Math.min(durationMs, start + MANUAL_MS) : start + MANUAL_MS;
  return { id: o.id, x: o.x, y: o.y, w: o.w, h: o.h, kind: "manual", enabled: true, score: 1, startMs: start, endMs: Math.max(end, start + 1) };
}

/**
 * Folds an overlay edit (toggle, resize, draw, delete) back into the state.
 * Track boxes can only be toggled; manual boxes also move, appear and vanish.
 */
export function applyVideoOverlay(state: VideoState, tracks: readonly RedactTrack[], prev: readonly OverlayBox[], next: readonly OverlayBox[], ms: number, durationMs: number): VideoState {
  const trackIds = new Set(tracks.map((t) => t.id));
  const nextTracks = { ...state.tracks };
  let manual = [...state.manual];
  const nextIds = new Set(next.map((b) => b.id));
  for (const o of next) {
    if (trackIds.has(o.id)) {
      nextTracks[o.id] = o.enabled;
      continue;
    }
    const i = manual.findIndex((m) => m.id === o.id);
    const cur = manual[i];
    if (cur) manual[i] = { ...cur, x: o.x, y: o.y, w: o.w, h: o.h, enabled: o.enabled };
    else manual.push(newTimedBox(o, ms, durationMs));
  }
  for (const p of prev) {
    if (!trackIds.has(p.id) && !nextIds.has(p.id)) manual = manual.filter((m) => m.id !== p.id);
  }
  return { tracks: nextTracks, manual };
}

export function setTrack(state: VideoState, id: string, enabled: boolean): VideoState {
  return { ...state, tracks: { ...state.tracks, [id]: enabled } };
}

export function setManualTime(state: VideoState, id: string, which: "start" | "end", ms: number, durationMs: number): VideoState {
  const v = Math.max(0, Math.min(durationMs > 0 ? durationMs : Infinity, Math.round(ms)));
  return {
    ...state,
    manual: state.manual.map((b) => {
      if (b.id !== id) return b;
      if (which === "start") return v < b.endMs ? { ...b, startMs: v } : b;
      return v > b.startMs ? { ...b, endMs: v } : b;
    }),
  };
}

export function removeManual(state: VideoState, id: string): VideoState {
  return { ...state, manual: state.manual.filter((b) => b.id !== id) };
}

export function enabledTrackCount(tracks: readonly RedactTrack[], state: VideoState): number {
  return tracks.filter((t) => state.tracks[t.id] ?? t.enabled).length;
}

export function videoApplyOptions(s: RedactSettings, detectionsPath: string, tracks: readonly RedactTrack[], state: VideoState): RedactOptions {
  return {
    ...baseOptions(s, RedactAction.ActionApply),
    detectionsPath,
    disabledTracks: tracks.filter((t) => !(state.tracks[t.id] ?? t.enabled)).map((t) => t.id),
    manualBoxes: state.manual.filter((b) => b.enabled).map((b) => ({ ...b })),
  };
}

// ---- live effect preview ----

export interface EffectParams {
  /** Gaussian blur sigma in pixels of the box area (blur). */
  sigma: number;
  /** Pixel block size in pixels of the box area (pixelate). */
  block: number;
}

/** Same formulas as the engine (SPEC §8.2), for a box of w x h pixels. */
export function effectParams(style: string, strength: number, w: number, h: number): EffectParams {
  const short = Math.max(1, Math.min(w, h));
  const st = Math.min(10, Math.max(1, strength));
  if (style === RedactStyle.StyleBlur) return { sigma: (0.04 + 0.016 * st) * short, block: 1 };
  if (style === RedactStyle.StylePixelate) return { sigma: 0, block: Math.max(1, short / (16 - st)) };
  return { sigma: 0, block: 1 };
}
