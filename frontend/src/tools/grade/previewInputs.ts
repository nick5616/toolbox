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
import type { EditProject, GradeMapState, EditSourceState } from "@/lib/api";
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
  const effects = showGrade ? serializeEffects(compileRecipe(a.recipe as GradeRecipe, a.wild, a.aux)) : "";

  // Region maps for the effects: stills by path, depth streams by id (ClipAux, SPEC §E5).
  let depth: { id: string; fromMs: number; toMs: number } | null = null;
  if (showGrade && a.maps) {
    const d = a.maps.depth;
    if (isVideo && d.ready && d.stream && url(d.stream)) {
      const dStream = d.stream;
      const dIndex = `${dStream}.idx.json`;
      if (url(dIndex)) {
        files.streams[`d:${path}`] = { url: url(dStream) as string, indexUrl: url(dIndex) as string };
        depth = { id: path, fromMs: 0, toMs: durationMs };
      }
    } else if (!isVideo && d.ready && d.still && url(d.still)) {
      files.images[`a:${d.still}`] = url(d.still) as string;
    }
    for (const m of ["subject", "people"] as const) {
      const info = a.maps[m];
      if (!isVideo && info.ready && info.still && url(info.still)) files.images[`a:${info.still}`] = url(info.still) as string;
    }
  }

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
