import { useEffect, useState } from "react";
import { ComposerService, FilesService, MediaService, VideoEditorService, type PostSlide, type ProjectInfo } from "@/lib/api";
import { rememberSize } from "./FramedMedia";
import { isPending } from "./logic";

/** The longest side of the selected slide's picture (the stage, and the phone preview). */
export const STAGE_DIM = 1280;
/** The slide strip's tiles. */
export const TILE_DIM = 240;

const MAX_CACHED = 80;
const cache = new Map<string, Promise<string>>();
/** Pictures that finished loading, so a newly mounted stage shows one in its first render. */
const resolved = new Map<string, string>();

/** Bumped per Video Editor project when Post Builder made it a new preview (its picture comes from the preview). */
const previewEpoch = new Map<string, number>();

/** A video slide's project has a new preview: its picture is read again. */
export function notePreviewMade(projectId: string): void {
  previewEpoch.set(projectId, (previewEpoch.get(projectId) ?? 0) + 1);
}

/** Forgets every resolved picture (tests, and after a linked project changed). */
export function clearVisualCache(): void {
  cache.clear();
  resolved.clear();
  warmed.clear();
}

export function visualKey(slide: PostSlide, project: ProjectInfo | undefined, maxDim: number): string {
  switch (slide.kind) {
    case "photo":
      return `p|${slide.path}|${maxDim}`;
    case "clip":
      return `c|${slide.path}|${slide.inMs}|${maxDim}`;
    case "video":
      return `v|${slide.projectId}|${project?.thumb ?? ""}|${project?.updatedAt ?? 0}|${previewEpoch.get(slide.projectId) ?? 0}|${maxDim}`;
    default:
      return `j|${project?.thumb ?? ""}|${project?.updatedAt ?? 0}|${maxDim}`;
  }
}

/** A Video Editor project has no thumbnail: its picture is a frame of its preview, when that is up to date. */
async function videoStill(projectId: string, maxDim: number): Promise<string> {
  const preview = projectId ? await VideoEditorService.FreshPreviewPath(projectId) : "";
  if (!preview) return "";
  try {
    return await MediaService.Frame(preview, 500, maxDim);
  } catch {
    return MediaService.Frame(preview, 0, maxDim);
  }
}

async function resolve(slide: PostSlide, project: ProjectInfo | undefined, maxDim: number): Promise<string> {
  switch (slide.kind) {
    case "photo":
      try {
        return await FilesService.ImageThumb(slide.path, maxDim);
      } catch (e) {
        // HEIC and other formats the Go decoder doesn't read: the engine converts them.
        try {
          return await ComposerService.LoadImage(slide.path, maxDim);
        } catch {
          throw e;
        }
      }
    case "clip":
      return MediaService.Frame(slide.path, slide.inMs, maxDim);
    case "video":
      return project?.thumb ? FilesService.ImageThumb(project.thumb, maxDim) : videoStill(slide.projectId, maxDim);
    default:
      return project?.thumb ? FilesService.ImageThumb(project.thumb, maxDim) : "";
  }
}

function forget(key: string): void {
  cache.delete(key);
  resolved.delete(key);
}

/** A picture (data or /media URL) for a slide, cached across tiles, stage and preview. */
export function loadVisual(slide: PostSlide, project: ProjectInfo | undefined, maxDim: number): Promise<string> {
  const key = visualKey(slide, project, maxDim);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = resolve(slide, project, maxDim);
  cache.set(key, p);
  p.then(
    (url) => {
      if (cache.get(key) === p) resolved.set(key, url);
    },
    () => {
      if (cache.get(key) === p) forget(key);
    },
  );
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    forget(oldest.value);
  }
  return p;
}

/** Pictures the prefetch already decoded. */
const warmed = new Set<string>();

/** Decodes a picture off screen and records its size, so showing it later costs nothing. */
function warm(url: string): Promise<void> {
  if (!url || warmed.has(url) || typeof Image === "undefined") return Promise.resolve();
  if (warmed.size > MAX_CACHED) warmed.clear();
  warmed.add(url);
  const img = new Image();
  img.src = url;
  return img.decode().then(
    () => rememberSize(url, img.naturalWidth, img.naturalHeight),
    () => undefined,
  );
}

let prefetchRun = 0;

/**
 * Loads (and decodes) the stage pictures of `slides` in the background, the
 * ones nearest `fromIndex` first, two at a time, so selecting another slide
 * shows its picture at once. A newer call stops an older one.
 */
export function prefetchVisuals(slides: readonly PostSlide[], projects: ReadonlyMap<string, ProjectInfo>, fromIndex: number): () => void {
  const run = ++prefetchRun;
  const order = slides
    .map((s, i) => ({ s, d: Math.abs(i - fromIndex) }))
    .filter(({ d }) => d > 0)
    .sort((a, b) => a.d - b.d)
    .map(({ s }) => s);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (run === prefetchRun) {
      const s = order[next++];
      if (!s) return;
      if (isPending(s)) continue;
      const project = projects.get(s.projectId);
      try {
        await warm(await loadVisual(s, project, STAGE_DIM));
      } catch {
        // The stage shows the problem when the slide is selected.
      }
    }
  };
  void worker();
  void worker();
  return () => {
    if (run === prefetchRun) prefetchRun++;
  };
}

export interface SlideVisual {
  url: string;
  status: "loading" | "ready" | "none" | "error";
}

function readyState(key: string, url: string): SlideVisual & { key: string } {
  return { key, url, status: url ? "ready" : "none" };
}

export function useSlideVisual(slide: PostSlide | undefined, project: ProjectInfo | undefined, maxDim: number): SlideVisual {
  const key = slide ? visualKey(slide, project, maxDim) : "";
  const [state, setState] = useState<SlideVisual & { key: string }>(() => {
    const hit = key ? resolved.get(key) : undefined;
    return hit !== undefined ? readyState(key, hit) : { url: "", status: "loading", key: "" };
  });

  useEffect(() => {
    if (!slide) return;
    const hit = resolved.get(key);
    if (hit !== undefined) {
      setState((s) => (s.key === key ? s : readyState(key, hit)));
      return;
    }
    let cancelled = false;
    loadVisual(slide, project, maxDim)
      .then((url) => {
        if (!cancelled) setState(readyState(key, url));
      })
      .catch(() => {
        if (!cancelled) setState({ key, url: "", status: "error" });
      });
    return () => {
      cancelled = true;
    };
    // The key captures everything the picture depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!slide) return { url: "", status: "none" };
  if (state.key === key) return state;
  // Already loaded (another tile or the prefetch got it): show it in this render.
  const hit = resolved.get(key);
  if (hit !== undefined) return readyState(key, hit);
  // Keep showing the previous picture while the next one loads, unless it was for another source kind.
  return { url: state.url, status: state.url ? "ready" : "loading" };
}
