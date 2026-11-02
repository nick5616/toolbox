import { useEffect, useState } from "react";
import { ComposerService, FilesService, MediaService, type PostSlide, type ProjectInfo } from "@/lib/api";

const MAX_CACHED = 80;
const cache = new Map<string, Promise<string>>();

/** Forgets every resolved picture (tests, and after a linked project changed). */
export function clearVisualCache(): void {
  cache.clear();
}

export function visualKey(slide: PostSlide, project: ProjectInfo | undefined, maxDim: number): string {
  switch (slide.kind) {
    case "photo":
      return `p|${slide.path}|${maxDim}`;
    case "clip":
      return `c|${slide.path}|${slide.inMs}|${maxDim}`;
    default:
      return `j|${project?.thumb ?? ""}|${project?.updatedAt ?? 0}|${maxDim}`;
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
    default:
      return project?.thumb ? FilesService.ImageThumb(project.thumb, maxDim) : "";
  }
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
  p.catch(() => cache.delete(key));
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  return p;
}

export interface SlideVisual {
  url: string;
  status: "loading" | "ready" | "none" | "error";
}

export function useSlideVisual(slide: PostSlide | undefined, project: ProjectInfo | undefined, maxDim: number): SlideVisual {
  const key = slide ? visualKey(slide, project, maxDim) : "";
  const [state, setState] = useState<SlideVisual & { key: string }>({ url: "", status: "loading", key: "" });

  useEffect(() => {
    if (!slide) return;
    let cancelled = false;
    loadVisual(slide, project, maxDim)
      .then((url) => {
        if (!cancelled) setState({ key, url, status: url ? "ready" : "none" });
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
  // Keep showing the previous picture while the next one loads, unless it was for another source kind.
  return state.key === key ? state : { url: state.url, status: state.url ? "ready" : "loading" };
}
