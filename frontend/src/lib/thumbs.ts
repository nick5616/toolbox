/**
 * Shared thumbnail plumbing: a real LRU, a concurrency limiter, in-flight
 * sharing, an "on screen" hook and `loadThumb`/`useThumbState` for
 * `FilesService.ImageThumb`. Every grid of previews goes through here so a
 * screen never asks for hundreds of thumbnails at once or for ones nobody sees.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { FilesService } from "@/lib/api";

export const MAX_CONCURRENT = 6;
export const THUMB_CACHE_SIZE = 500;

/** Least-recently-used map. */
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

/** A queue that runs at most `limit` tasks at once. */
export class Limiter {
  private active = 0;
  private waiting: Job[] = [];
  peak = 0;
  constructor(private readonly limit: number) {}
  push<T>(task: () => Promise<T>, cancelled: () => boolean = () => false): Promise<T | undefined> {
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

/** The limiter every thumbnail/preview load shares. */
export const thumbLimiter = new Limiter(MAX_CONCURRENT);

interface Flight<V> {
  promise: Promise<V | undefined>;
  cancels: Set<() => boolean>;
}

/**
 * An LRU cache with in-flight sharing and the shared limiter. A queued load is
 * only dropped when every caller waiting for it has cancelled.
 */
export class SharedLoader<V> {
  private cache: LRU<V>;
  private inflight = new Map<string, Flight<V>>();
  constructor(
    size: number,
    private readonly limiter: Limiter = thumbLimiter,
  ) {
    this.cache = new LRU<V>(size);
  }
  peek(key: string): V | undefined {
    return this.cache.get(key);
  }
  load(key: string, fetch: () => Promise<V>, cancelled: () => boolean = () => false): Promise<V | undefined> {
    const hit = this.cache.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const running = this.inflight.get(key);
    if (running) {
      running.cancels.add(cancelled);
      return running.promise;
    }
    const cancels = new Set<() => boolean>([cancelled]);
    const promise = this.limiter
      .push(
        async () => {
          const data = await fetch();
          this.cache.set(key, data);
          return data;
        },
        () => [...cancels].every((c) => c()),
      )
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, { promise, cancels });
    return promise;
  }
  clear(): void {
    this.cache.clear();
    this.inflight.clear();
  }
}

const thumbs = new SharedLoader<string>(THUMB_CACHE_SIZE);

function thumbKey(path: string, maxDim: number, stamp: string): string {
  return `${path}\u0000${maxDim}\u0000${stamp}`;
}

/** A thumbnail made before (synchronous), or undefined. */
export function cachedThumb(path: string, maxDim: number, stamp = ""): string | undefined {
  return thumbs.peek(thumbKey(path, maxDim, stamp));
}

/** `FilesService.ImageThumb` through the shared queue, cache and in-flight sharing. `stamp` busts the cache when the file changed. */
export function loadThumb(path: string, maxDim: number, stamp = "", cancelled: () => boolean = () => false): Promise<string | undefined> {
  return thumbs.load(thumbKey(path, maxDim, stamp), () => FilesService.ImageThumb(path, maxDim), cancelled);
}

export function clearThumbs(): void {
  thumbs.clear();
}

/** True once the element has been near the screen (always true where IntersectionObserver is missing, e.g. tests). */
export function useInView<T extends Element>(rootMargin = "200px"): [RefObject<T | null>, boolean] {
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
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, rootMargin]);
  return [ref, seen];
}

export type ThumbResult = { status: "loading" } | { status: "ok"; src: string } | { status: "error"; error: unknown };

/** Loads a thumbnail when `enabled` (a cache hit shows in the first render). */
export function useThumbState(path: string, maxDim: number, enabled = true, stamp = ""): ThumbResult {
  const [state, setState] = useState<ThumbResult>(() => {
    const hit = path ? cachedThumb(path, maxDim, stamp) : undefined;
    return hit ? { status: "ok", src: hit } : { status: "loading" };
  });
  useEffect(() => {
    const hit = path ? cachedThumb(path, maxDim, stamp) : undefined;
    if (hit) {
      setState({ status: "ok", src: hit });
      return;
    }
    setState({ status: "loading" });
    if (!enabled) return;
    let off = false;
    loadThumb(path, maxDim, stamp, () => off).then(
      (src) => {
        if (!off && src !== undefined) setState({ status: "ok", src });
      },
      (error: unknown) => {
        if (!off) setState({ status: "error", error });
      },
    );
    return () => {
      off = true;
    };
  }, [path, maxDim, stamp, enabled]);
  return state;
}

/** For galleries: a ref to put on the thumbnail box and the data URL ("" until it's loaded, and for no path). */
export function useLazyThumb<T extends Element>(path: string, maxDim: number, stamp = ""): [RefObject<T | null>, string] {
  const [ref, seen] = useInView<T>();
  const t = useThumbState(path, maxDim, seen && path !== "", stamp);
  return [ref, path !== "" && t.status === "ok" ? t.src : ""];
}
