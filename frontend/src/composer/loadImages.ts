import { ComposerService } from "@/lib/api";
import type { ImageMap } from "./render";

// Decoded source images for the renderer. Pictures come from
// ComposerService.LoadImage (data URL, orientation applied, HEIC converted by
// the engine) and are cached as ImageBitmaps by path + maxDim.

/** Longest side while editing / when exporting. */
export const EDIT_DIM = 2048;
export const EXPORT_DIM = 4096;

const CACHE_ENTRIES = 48;

const cache = new Map<string, ImageBitmap>();
const inflight = new Map<string, Promise<ImageBitmap>>();

const keyOf = (path: string, maxDim: number): string => `${maxDim}|${path}`;

/** Decodes a base64 data URL into a bitmap without going through fetch. */
export async function dataUrlToBitmap(url: string): Promise<ImageBitmap> {
  const comma = url.indexOf(",");
  const mime = /^data:([^;,]+)/.exec(url)?.[1] ?? "image/png";
  const bin = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return createImageBitmap(new Blob([bytes], { type: mime }));
}

/** Loads (or returns the cached) bitmap of path at maxDim. */
export function loadImage(path: string, maxDim: number = EDIT_DIM): Promise<ImageBitmap> {
  const key = keyOf(path, maxDim);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return Promise.resolve(hit);
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = ComposerService.LoadImage(path, maxDim)
    .then(dataUrlToBitmap)
    .then((bmp) => {
      cache.set(key, bmp);
      while (cache.size > CACHE_ENTRIES) {
        const oldest = cache.keys().next();
        if (oldest.done) break;
        cache.delete(oldest.value); // dropped, not closed: a render may still hold it
      }
      return bmp;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** The cached bitmap, if loaded. */
export function cachedImage(path: string, maxDim: number = EDIT_DIM): ImageBitmap | undefined {
  return cache.get(keyOf(path, maxDim));
}

export interface LoadedImages {
  images: Map<string, ImageBitmap>;
  /** Paths that failed, with the reason. */
  failed: Map<string, string>;
}

/** Loads every path; failures don't reject (the renderer skips missing images). */
export async function loadImages(paths: readonly string[], maxDim: number = EDIT_DIM): Promise<LoadedImages> {
  const images = new Map<string, ImageBitmap>();
  const failed = new Map<string, string>();
  await Promise.all(
    [...new Set(paths)].map(async (p) => {
      try {
        images.set(p, await loadImage(p, maxDim));
      } catch (e) {
        failed.set(p, e instanceof Error ? e.message : String(e));
      }
    }),
  );
  return { images, failed };
}

/** Forgets a path (its file changed, e.g. after Remove background). */
export function forgetImage(path: string): void {
  for (const k of [...cache.keys()]) if (k.endsWith(`|${path}`)) cache.delete(k);
}

export function clearImageCache(): void {
  cache.clear();
  inflight.clear();
}

export const asImageMap = (m: Map<string, ImageBitmap>): ImageMap => m;
