/**
 * The window's decoded images (Phase 11, SPEC §5.1). `ImageBitmap`s are never
 * bridged: every window that draws the composition (the tool, a popped-out
 * preview or panel) loads its own, from the document's paths.
 */
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { toast } from "@/components";
import { loadImages } from "@/composer/loadImages";
import { imagePaths } from "@/composer/render";
import type { Composition } from "@/lib/api";

interface ImagesState {
  images: ReadonlyMap<string, ImageBitmap>;
}

/** This window's bitmaps by path. */
export const useComposerImages = create<ImagesState>(() => ({ images: new Map() }));

/** Non-hook read (store actions that lay out photos). */
export function composerImages(): ReadonlyMap<string, ImageBitmap> {
  return useComposerImages.getState().images;
}

const reported = new Set<string>();

/** True when loading `path` already failed (and was reported). */
export function imageFailed(path: string): boolean {
  return reported.has(path);
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/** Keeps `useComposerImages` in step with the document. Failures are toasted once per path when `report` is on. */
export function useLoadComposerImages(doc: Composition | null, report = true): void {
  const key = useMemo(() => (doc ? imagePaths(doc).join("\n") : ""), [doc]);
  useEffect(() => {
    reported.clear();
  }, []);
  useEffect(() => {
    const need = key ? key.split("\n") : [];
    let off = false;
    void loadImages(need).then((r) => {
      if (off) return;
      const prev = useComposerImages.getState().images;
      let same = prev.size === r.images.size;
      if (same) for (const [k, v] of r.images) if (prev.get(k) !== v) same = false;
      if (!same) useComposerImages.setState({ images: new Map(r.images) });
      for (const [p, msg] of r.failed) {
        if (reported.has(p)) continue;
        reported.add(p);
        if (report) toast({ title: `Couldn't load ${baseName(p)}`, description: msg, tone: "warn" });
      }
    });
    return () => {
      off = true;
    };
  }, [key, report]);
}
