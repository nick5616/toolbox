/**
 * Caches of the frame provider (Phase 9 SPEC §8.2): a per-stream byte cache
 * (16 MiB) and an LRU of decoded frames with per-stream and total caps.
 * Generic and GL-free so the close discipline can be tested with fakes.
 */

export const BYTE_CACHE_LIMIT = 16 * 1024 * 1024;

interface Segment {
  start: number;
  data: Uint8Array;
  used: number;
}

/** Fetched byte ranges of one stream file, least recently used evicted past `limit`. */
export class ByteCache {
  private readonly segs = new Map<number, Segment>();
  private total = 0;
  private tick = 0;

  constructor(private readonly limit = BYTE_CACHE_LIMIT) {}

  get size(): number {
    return this.total;
  }

  put(start: number, data: Uint8Array): void {
    const old = this.segs.get(start);
    if (old) this.total -= old.data.length;
    this.segs.set(start, { start, data, used: ++this.tick });
    this.total += data.length;
    while (this.total > this.limit && this.segs.size > 1) {
      let oldest: Segment | null = null;
      for (const s of this.segs.values()) if (s.start !== start && (!oldest || s.used < oldest.used)) oldest = s;
      if (!oldest) break;
      this.segs.delete(oldest.start);
      this.total -= oldest.data.length;
    }
  }

  private find(pos: number): Segment | null {
    for (const s of this.segs.values()) if (s.start <= pos && pos < s.start + s.data.length) return s;
    return null;
  }

  /** The bytes [start, end), or null unless the cache covers them (possibly across adjacent segments). */
  slice(start: number, end: number): Uint8Array | null {
    if (end <= start) return new Uint8Array(0);
    const parts: Uint8Array[] = [];
    let pos = start;
    while (pos < end) {
      const hit = this.find(pos);
      if (!hit) return null;
      hit.used = ++this.tick;
      const to = Math.min(end, hit.start + hit.data.length);
      parts.push(hit.data.subarray(pos - hit.start, to - hit.start));
      pos = to;
    }
    if (parts.length === 1) return parts[0] as Uint8Array;
    const out = new Uint8Array(end - start);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  has(start: number, end: number): boolean {
    let pos = start;
    while (pos < end) {
      const hit = this.find(pos);
      if (!hit) return false;
      pos = hit.start + hit.data.length;
    }
    return true;
  }

  clear(): void {
    this.segs.clear();
    this.total = 0;
  }
}

export interface LRUOptions<T> {
  perStream: number;
  total: number;
  /** Called exactly once for every image that leaves the cache (close it). */
  dispose(image: T): void;
}

interface Entry<T> {
  image: T;
  used: number;
}

export const frameKeyString = (stream: string, frame: number): string => `${stream}#${frame}`;

/** Decoded frames by (stream, frame), least recently used evicted past the caps. */
export class FrameLRU<T> {
  private readonly streams = new Map<string, Map<number, Entry<T>>>();
  private tick = 0;
  private count = 0;
  private keep: ReadonlySet<string> = new Set();

  constructor(private o: LRUOptions<T>) {}

  get size(): number {
    return this.count;
  }

  /** Changes the caps (taking effect on the next put). */
  setCaps(perStream: number, total: number): void {
    this.o = { ...this.o, perStream, total };
  }

  sizeOf(stream: string): number {
    return this.streams.get(stream)?.size ?? 0;
  }

  /** Keys that eviction must skip (frames the current render needs). */
  protect(keys: ReadonlySet<string>): void {
    this.keep = keys;
  }

  has(stream: string, frame: number): boolean {
    return this.streams.get(stream)?.has(frame) ?? false;
  }

  get(stream: string, frame: number): T | undefined {
    const e = this.streams.get(stream)?.get(frame);
    if (!e) return undefined;
    e.used = ++this.tick;
    return e.image;
  }

  /** The newest resident frame before `frame`. */
  nearestBefore(stream: string, frame: number): { frame: number; image: T } | undefined {
    const m = this.streams.get(stream);
    if (!m) return undefined;
    let best = -1;
    for (const f of m.keys()) if (f < frame && f > best) best = f;
    if (best < 0) return undefined;
    const e = m.get(best) as Entry<T>;
    e.used = ++this.tick;
    return { frame: best, image: e.image };
  }

  frames(stream: string): number[] {
    return [...(this.streams.get(stream)?.keys() ?? [])];
  }

  /** Stores an image (disposing any previous one for that frame), then enforces the caps. */
  put(stream: string, frame: number, image: T): void {
    let m = this.streams.get(stream);
    if (!m) {
      m = new Map();
      this.streams.set(stream, m);
    }
    const old = m.get(frame);
    if (old) {
      if (old.image !== image) this.o.dispose(old.image);
      this.count--;
    }
    m.set(frame, { image, used: ++this.tick });
    this.count++;
    this.evict(stream, frame);
  }

  /** Swaps an image in place without touching recency (upload-mode conversions); disposes `from`. */
  replace(stream: string, frame: number, from: T, to: T): boolean {
    const e = this.streams.get(stream)?.get(frame);
    if (!e || e.image !== from) return false;
    e.image = to;
    this.o.dispose(from);
    return true;
  }

  private evict(stream: string, justPut: number): void {
    const m = this.streams.get(stream);
    while (m && m.size > this.o.perStream) {
      if (!this.evictOldest(m, stream, justPut)) break;
    }
    while (this.count > this.o.total) {
      if (!this.evictOldest(null, stream, justPut)) break;
    }
  }

  private evictOldest(only: Map<number, Entry<T>> | null, justStream: string, justPut: number): boolean {
    let bs: string | null = null;
    let bf = -1;
    let bu = Infinity;
    for (const [s, m] of this.streams) {
      if (only && only !== m) continue;
      for (const [f, e] of m) {
        if ((s === justStream && f === justPut) || this.keep.has(frameKeyString(s, f))) continue;
        if (e.used < bu) {
          bu = e.used;
          bs = s;
          bf = f;
        }
      }
    }
    if (bs === null) return false;
    const m = this.streams.get(bs);
    const e = m?.get(bf);
    if (!m || !e) return false;
    m.delete(bf);
    this.count--;
    this.o.dispose(e.image);
    return true;
  }

  deleteStream(stream: string): void {
    const m = this.streams.get(stream);
    if (!m) return;
    for (const e of m.values()) this.o.dispose(e.image);
    this.count -= m.size;
    this.streams.delete(stream);
  }

  clear(): void {
    for (const s of [...this.streams.keys()]) this.deleteStream(s);
  }
}
