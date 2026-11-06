import { useEffect, useRef, useState, type RefObject } from "react";
import { FilesService, MediaService, PdfService } from "@/lib/api";
import { previewKind, type LibItem } from "../items";

/** What a card shows for one file, whatever its type. */
export type PreviewData =
  | { kind: "image"; src: string }
  | { kind: "video"; sprite: string }
  | { kind: "audio"; peaks: number[] }
  | { kind: "pdf"; src: string; pages: number }
  | { kind: "text"; text: string };

export const MAX_CONCURRENT = 6;
export const CACHE_SIZE = 500;
export const THUMB_PX = 320;
export const FILMSTRIP_FRAMES = 8;
export const WAVE_BUCKETS = 100;

/** Least-recently-used map (exported for tests). */
export class LRU<V> {
  private m = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(k: string): V | undefined {
    const v = this.m.get(k);
    if (v === undefined) return undefined;
    this.m.delete(k);
    this.m.set(k, v);
    return v;
  }
  set(k: string, v: V): void {
    this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.max) {
      const oldest = this.m.keys().next().value;
      if (oldest === undefined) break;
      this.m.delete(oldest);
    }
  }
  has(k: string): boolean {
    return this.m.has(k);
  }
  get size(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
}

interface Job {
  run: () => Promise<void>;
}

/** A queue that runs at most `limit` tasks at once (exported for tests). */
export class Limiter {
  private active = 0;
  private waiting: Job[] = [];
  peak = 0;
  constructor(private readonly limit: number) {}
  push<T>(task: () => Promise<T>, cancelled: () => boolean): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const job: Job = {
        run: async () => {
          if (cancelled()) return resolve(undefined);
          this.active++;
          this.peak = Math.max(this.peak, this.active);
          try {
            resolve(await task());
          } catch (e) {
            reject(e);
          } finally {
            this.active--;
            this.next();
          }
        },
      };
      this.waiting.push(job);
      this.next();
    });
  }
  private next(): void {
    while (this.active < this.limit && this.waiting.length > 0) {
      const j = this.waiting.shift();
      if (j) void j.run();
    }
  }
}

const cache = new LRU<PreviewData>(CACHE_SIZE);
const inflight = new Map<string, Promise<PreviewData | undefined>>();
const limiter = new Limiter(MAX_CONCURRENT);

/** Cache key: path plus when the file changed (mtime, or the output's createdAt). */
export function previewKey(i: Pick<LibItem, "path" | "at" | "sizeBytes">): string {
  return `${i.path}|${i.at}|${i.sizeBytes}`;
}

export function clearPreviewCache(): void {
  cache.clear();
  inflight.clear();
}

export function cachedPreview(i: LibItem): PreviewData | undefined {
  return cache.get(previewKey(i));
}

async function fetchPreview(i: LibItem): Promise<PreviewData> {
  switch (previewKind(i)) {
    case "image":
      return { kind: "image", src: await FilesService.ImageThumb(i.path, THUMB_PX) };
    case "video":
      // One sprite of 8 frames serves the poster (an early frame) and the hover scrub.
      return { kind: "video", sprite: await MediaService.Filmstrip(i.path, FILMSTRIP_FRAMES, 120) };
    case "audio":
      return { kind: "audio", peaks: (await MediaService.Waveform(i.path, WAVE_BUCKETS)) ?? [] };
    case "pdf": {
      const [src, info] = await Promise.all([PdfService.Thumbnail(i.path, 1, 240, ""), PdfService.Info(i.path, "").catch(() => null)]);
      return { kind: "pdf", src, pages: info?.pages ?? 0 };
    }
    case "text":
      return { kind: "text", text: await FilesService.ReadText(i.path, 2048) };
    default:
      throw new Error("no preview");
  }
}

/** Loads a preview through the queue (≤ 6 at once) and the cache. `cancelled` drops a not-yet-started load. */
export function loadPreview(i: LibItem, cancelled: () => boolean = () => false): Promise<PreviewData | undefined> {
  const key = previewKey(i);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running) return running;
  const p = limiter
    .push(async () => {
      const data = await fetchPreview(i);
      cache.set(key, data);
      return data;
    }, cancelled)
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** True once the element has been on screen (always true where IntersectionObserver is missing, e.g. tests). */
export function useInView<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (seen) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}
