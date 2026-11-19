/**
 * The Color Grader's preview is a one-clip edit (Phase 21 SPEC §E3.2): the
 * picture or video as one clip at its own aspect, with the effects
 * `compileRecipe` makes from the look at the current Wildness. These pure
 * helpers build that edit's inputs for the live preview and for the gallery's
 * thumbnails, so both draw the same thing the export will.
 */
import { useMemo } from "react";
import { newClip } from "@/editor/doc";
import { compileRecipe } from "@/grade/compile";
import type { GradeAuxState, GradeRecipe } from "@/grade/types";
import type { EditClip, EditMatte, EditProject, GradeMapState, EditSourceState } from "@/lib/api";
import { emptyEditProject } from "@/viz/edit/defaults";
import { emptyAnalysis } from "@/viz/edit/emptyAnalysis";
import { serializeEffects } from "@/viz/edit/schema";
import type { EditFiles, EditInputs } from "@/viz/edit/types";
import { mapReady } from "./recipe";
import { useGrade } from "./store";

export interface FrameSize {
  width: number;
  height: number;
}

/** The picture's size as the edit draws it (oriented). Unknown → 16:9. */
export function sourceSize(src: EditSourceState | null): FrameSize {
  const st = src?.preview;
  let w = st?.width || src?.info.width || 0;
  let h = st?.height || src?.info.height || 0;
  if (!st && (src?.info.rotation === 90 || src?.info.rotation === 270 || src?.info.rotation === -90)) [w, h] = [h, w];
  return w > 0 && h > 0 ? { width: w, height: h } : { width: 16, height: 9 };
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

/** `size` fitted inside `box`, even sides, never above `maxLong` on the long side. */
export function fitSize(size: FrameSize, box: FrameSize, maxLong = 1920): FrameSize {
  const k = Math.min(box.width / size.width, box.height / size.height, maxLong / Math.max(size.width, size.height));
  if (!(k > 0)) return { width: 2, height: 2 };
  return { width: even(size.width * k), height: even(size.height * k) };
}

export interface BuildArgs {
  path: string;
  src: EditSourceState | null;
  urls: Readonly<Record<string, string>>;
  recipe: GradeRecipe | null;
  wild: number;
  aux: GradeAuxState;
  maps: GradeMapState | null;
  size: FrameSize;
  /** Draw a region map as the picture instead (View this map). */
  view?: "" | "depth" | "subject" | "people";
}

const DURATION_STILL_MS = 1000;

/** The map ids of the one-clip edit (EditFiles `d:depth`, `m:subject`; the export job uses the same). */
const DEPTH_ID = "depth";
const SUBJECT_ID = "subject";

/** The edit stream (index next to it, editstudio.IndexPath) of a video's map at the preview tier, or null. */
export function mapStream(info: GradeMapState["depth"], url: (p: string | undefined) => string | undefined): { url: string; indexUrl: string } | null {
  if (!info.ready || !info.stream) return null;
  for (const stream of [previewTier(info.stream), info.stream]) {
    const u = url(stream);
    const i = url(streamIndex(stream));
    if (u && i) return { url: u, indexUrl: i };
  }
  return null;
}

/** `<name>-export.h264` → `<name>-preview.h264` (modules/grade/maps.go). */
export const previewTier = (stream: string): string => stream.replace(/-export\.h264$/, "-preview.h264");
/** The index of an edit stream: `x.h264` → `x.idx.json` (editstudio.IndexPath). */
export const streamIndex = (stream: string): string => stream.replace(/\.h264$/, "") + ".idx.json";

/** A matte that only carries the subject map for the look's regions: the clip itself draws whole. */
function auxMatte(mode: "image" | "people", toMs: number): EditMatte {
  return { mode, id: SUBJECT_ID, fromMs: 0, toMs, clicks: [], cutout: false, invert: false, feather: 0, stroke: { px: 0, color: "#ffffff" }, glow: { amount: 0, color: "#ffffff" } };
}

/** Whether the open input's picture (or preview stream) has URLs yet. */
export function previewReady(src: EditSourceState | null, urls: Readonly<Record<string, string>>): boolean {
  if (!src) return false;
  if (src.info.kind === "video") return !!(src.preview && urls[src.preview.stream] && urls[src.preview.index]);
  return !!(src.image && urls[src.image]);
}

/** The EditInputs of the one-clip preview, or null while the picture isn't ready. */
export function buildInputs(a: BuildArgs): EditInputs | null {
  const { path, src } = a;
  if (!path || !src) return null;
  const isVideo = src.info.kind === "video";
  const files: EditFiles = { streams: {}, images: {} };
  const url = (p: string | undefined) => (p ? a.urls[p] : undefined);

  const view = a.view ?? "";
  const mapInfo = view ? a.maps?.[view] : undefined;
  const viewStill = mapInfo?.still || mapInfo?.preview || "";

  let kind: "video" | "image" = isVideo ? "video" : "image";
  let key = path;
  if (view && viewStill && url(viewStill)) {
    kind = "image";
    key = viewStill;
    files.images[`p:${viewStill}`] = url(viewStill) as string;
  } else if (isVideo) {
    const s = src.preview;
    const u = url(s?.stream);
    const i = url(s?.index);
    if (!u || !i) return null;
    files.streams[`v:${path}`] = { url: u, indexUrl: i };
  } else {
    const u = url(src.image);
    if (!u) return null;
    files.images[`p:${path}`] = u;
  }

  const fps = Math.max(1, Math.round(isVideo ? src.preview?.fps || src.info.fps || 30 : 30));
  const durationMs = isVideo ? Math.max(100, src.info.durationMs) : DURATION_STILL_MS;
  const showGrade = !view && !!a.recipe;

  // Region maps for the effects, the same way the export job (modules/grade/run.go) passes them: the clip names
  // them (depth {id: "depth"}, matte {id: "subject"}) and the files hold `d:depth` / `m:subject` — the PNG for a
  // picture, the preview-tier edit stream for a video (viz/edit/clipAux.ts clipAuxOf).
  let depth: EditClip["depth"] = null;
  let matte: EditMatte | null = null;
  if (showGrade && a.maps) {
    const d = a.maps.depth;
    const s = a.maps.subject;
    if (isVideo) {
      const ds = mapStream(d, url);
      if (ds) {
        files.streams[`d:${DEPTH_ID}`] = ds;
        depth = { id: DEPTH_ID, fromMs: 0, toMs: durationMs };
      }
      const ss = mapStream(s, url);
      if (ss) {
        files.streams[`m:${SUBJECT_ID}`] = ss;
        matte = auxMatte("people", durationMs);
      }
    } else {
      if (d.ready && d.still && url(d.still)) {
        files.images[`d:${DEPTH_ID}`] = url(d.still) as string;
        depth = { id: DEPTH_ID, fromMs: 0, toMs: 0 };
      }
      if (s.ready && s.still && url(s.still)) {
        files.images[`m:${SUBJECT_ID}`] = url(s.still) as string;
        matte = auxMatte("image", 0);
      }
    }
  }

  // Ops on a map that isn't attached (yet) compile as the export would without it.
  const aux: GradeAuxState = { depth: a.aux.depth && !!depth, subject: a.aux.subject && !!matte, people: a.aux.people && !!matte };
  const effects = showGrade ? serializeEffects(compileRecipe(a.recipe as GradeRecipe, a.wild, aux)) : "";

  const project: EditProject = {
    ...emptyEditProject(`${a.size.width}:${a.size.height}`, fps, 1),
    size: { w: a.size.width, h: a.size.height },
  };
  const clip = newClip({
    id: "grade",
    kind,
    path: key,
    startMs: 0,
    endMs: kind === "video" ? durationMs : DURATION_STILL_MS,
    fit: "fill",
    effects,
    depth,
    matte,
  });
  project.tracks = [{ id: "t1", kind: "video", name: "Video 1", muted: false, locked: false, matte: "", clips: [clip] }];
  return { project, analysis: emptyAnalysis(), markers: [], files };
}

/** The preview's inputs from the store at a drawing size. */
export function useGradeInputs(size: FrameSize, opts: { graded: boolean } = { graded: true }): EditInputs | null {
  const path = useGrade((s) => s.selected);
  const src = useGrade((s) => s.src);
  const urls = useGrade((s) => s.urls);
  const recipe = useGrade((s) => s.recipe);
  const wild = useGrade((s) => s.wild);
  const maps = useGrade((s) => s.maps);
  const view = useGrade((s) => s.mapView);
  const { graded } = opts;
  return useMemo(
    () => buildInputs({ path, src, urls, recipe: graded ? recipe : null, wild, aux: mapReady(maps), maps, size, view: graded ? view : "" }),
    [path, src, urls, recipe, wild, maps, size, view, graded],
  );
}
