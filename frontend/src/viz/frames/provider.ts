/**
 * The frame provider (Phase 9 SPEC §8.1, §8.2, §22.1): decoded video frames
 * and edit images for the EditEngine, on the main thread (preview, inexact)
 * and in the export worker (exact).
 *
 * Frames are demanded three ways: `prepare(keys, exact)` (the frames the
 * render at hand uses), `hint(ahead, playing)` (decode-ahead while playing)
 * and nothing else. A StreamDecoder per stream serves the union of the
 * demands. Photos and image mattes are FrameKeys whose `stream` is an
 * EditFiles.images key (frame 0), so one `needs()` list covers everything.
 */
import { fetchAll } from "../analysis";
import { RenderError } from "../worker/transport";
import { frameKeyString, FrameLRU } from "./cache";
import { StreamDecoder, REAL_ENV, hasVideoDecoder, type DecoderEnv } from "./decoder";
import { clampFrame, parseStreamIndex } from "./gop";
import { StreamBytes } from "./source";
import type { FrameImage, FrameKey, FrameProvider, StreamIndex, StreamRef } from "./types";
import { getUploadMode, isVideoFrame } from "./upload";

export interface ProviderFiles {
  streams: Record<string, StreamRef>;
  images: Record<string, string>;
}

export interface ProviderOptions {
  files: ProviderFiles;
  /** "preview": inexact frames allowed, caps 24/stream and 120 total. "export": exact, 8 per stream. */
  mode: "preview" | "export";
  fetchImpl?: typeof fetch;
  env?: DecoderEnv;
  /** Test hooks. */
  convert?: (frame: VideoFrame) => Promise<ImageBitmap>;
  decodeImage?: (bytes: Uint8Array) => Promise<ImageBitmap>;
  /** Frames kept decoded ahead of the playhead per stream (preview). */
  aheadFrames?: number;
}

export const PREVIEW_PER_STREAM = 24;
export const PREVIEW_TOTAL = 120;
export const EXPORT_PER_STREAM = 8;
/** Direct mode holds VideoFrames open, which stalls hardware decoders when many are held. */
export const DIRECT_PER_STREAM = 12;
export const DIRECT_TOTAL = 48;
/** Decode-ahead while frames are held as VideoFrames. */
export const DIRECT_AHEAD = 6;
const AHEAD_FRAMES = 15;
const IMAGE_CAP = 32;

interface Rec {
  key: string;
  ref: StreamRef;
  indexPromise: Promise<StreamIndex> | null;
  index: StreamIndex | null;
  bytes: StreamBytes | null;
  dec: StreamDecoder | null;
  /** Frames accepted from the decoder whose conversion is still running. */
  pending: Set<number>;
  error: string;
}

interface Demand {
  frames: Map<string, Set<number>>;
  images: Set<string>;
}

interface ExactDemand extends Demand {
  resolve(): void;
  reject(e: Error): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const defaultConvert = (f: VideoFrame): Promise<ImageBitmap> => createImageBitmap(f);
const defaultDecodeImage = (b: Uint8Array): Promise<ImageBitmap> => createImageBitmap(new Blob([b as BlobPart]));

function disposeImage(img: FrameImage): void {
  img.close();
}

export class EditFrameProvider implements FrameProvider {
  private files: ProviderFiles;
  private readonly recs = new Map<string, Rec>();
  private readonly lru: FrameLRU<FrameImage>;
  private readonly fetchImpl: typeof fetch;
  private readonly env: DecoderEnv;
  private readonly convert: (f: VideoFrame) => Promise<ImageBitmap>;
  private readonly decodeImage: (b: Uint8Array) => Promise<ImageBitmap>;
  private readonly exactMode: boolean;
  private readonly aheadN: number;
  private readonly exacts = new Set<ExactDemand>();
  private current: Demand | null = null;
  private ahead: Demand | null = null;
  private readonly bitmaps = new Map<string, { bmp: ImageBitmap; used: number }>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly imageErrors = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private tick = 0;
  private disposed = false;
  /** The last decode or load failure (shown by the preview). */
  lastError = "";

  constructor(o: ProviderOptions) {
    this.files = o.files;
    this.exactMode = o.mode === "export";
    this.fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
    this.env = o.env ?? REAL_ENV;
    this.convert = o.convert ?? defaultConvert;
    this.decodeImage = o.decodeImage ?? defaultDecodeImage;
    this.aheadN = o.aheadFrames ?? AHEAD_FRAMES;
    this.lru = new FrameLRU<FrameImage>({
      perStream: this.exactMode ? EXPORT_PER_STREAM : PREVIEW_PER_STREAM,
      total: this.exactMode ? 1000 : PREVIEW_TOTAL,
      dispose: disposeImage,
    });
  }

  /** True when decoding is possible here (WebCodecs present or an injected env). */
  static supported(): boolean {
    return hasVideoDecoder();
  }

  // ---- files ----

  /** Points the provider at new files; unchanged streams keep their decoded frames. */
  setFiles(files: ProviderFiles): void {
    this.files = files;
    for (const [k, rec] of [...this.recs]) {
      const ref = files.streams[k];
      if (!ref || ref.url !== rec.ref.url || ref.indexUrl !== rec.ref.indexUrl) {
        this.dropRec(k, rec);
      }
    }
    for (const k of [...this.bitmaps.keys()]) {
      if (!(k in files.images) || files.images[k] !== this.imageUrls.get(k)) {
        this.bitmaps.get(k)?.bmp.close();
        this.bitmaps.delete(k);
      }
    }
    for (const k of [...this.imageUrls.keys()]) if (files.images[k] !== this.imageUrls.get(k)) this.imageUrls.delete(k);
    this.imageErrors.clear();
  }
  private readonly imageUrls = new Map<string, string>();

  private dropRec(k: string, rec: Rec): void {
    rec.dec?.dispose();
    this.lru.deleteStream(k);
    this.recs.delete(k);
  }

  private rec(stream: string): Rec | null {
    let r = this.recs.get(stream);
    if (r) return r;
    const ref = this.files.streams[stream];
    if (!ref) return null;
    r = { key: stream, ref, indexPromise: null, index: null, bytes: null, dec: null, pending: new Set(), error: "" };
    this.recs.set(stream, r);
    return r;
  }

  private loadIndex(rec: Rec): Promise<StreamIndex> {
    if (!rec.indexPromise) {
      rec.indexPromise = fetchAll(rec.ref.indexUrl, this.fetchImpl)
        .then((bytes) => parseStreamIndex(JSON.parse(new TextDecoder().decode(bytes))))
        .then((idx) => {
          rec.index = idx;
          rec.bytes = new StreamBytes(rec.ref.url, idx, this.fetchImpl);
          return idx;
        });
      rec.indexPromise.catch((e: unknown) => this.failStream(rec.key, e instanceof Error ? e : new Error(String(e))));
    }
    return rec.indexPromise;
  }

  /** Loads the indexes of streams (the worker does this before compiling) and returns their frame counts. */
  async loadIndexes(streams: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    await Promise.all(
      streams.map(async (s) => {
        const rec = this.rec(s);
        if (!rec) return;
        try {
          out[s] = (await this.loadIndex(rec)).frames;
        } catch {
          // reported through failStream
        }
      }),
    );
    return out;
  }

  /** Frame counts of the streams whose index is loaded. */
  streamFrames(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, r] of this.recs) if (r.index) out[k] = r.index.frames;
    return out;
  }

  /** Decoder statistics for Edit Lab. */
  stats(): Record<string, { resets: number; runs: number; requests: number; resident: number }> {
    const out: Record<string, { resets: number; runs: number; requests: number; resident: number }> = {};
    for (const [k, r] of this.recs) out[k] = { resets: r.dec?.resets ?? 0, runs: r.dec?.runs ?? 0, requests: r.bytes?.requests.length ?? 0, resident: this.lru.sizeOf(k) };
    return out;
  }

  // ---- demands ----

  private group(keys: readonly FrameKey[], cap = Infinity): Demand {
    const d: Demand = { frames: new Map(), images: new Set() };
    for (const k of keys) {
      if (k.stream in this.files.streams) {
        let s = d.frames.get(k.stream);
        if (!s) {
          s = new Set();
          d.frames.set(k.stream, s);
        }
        if (s.size < cap) s.add(Math.max(0, Math.floor(k.frame)));
      } else if (k.stream in this.files.images) d.images.add(k.stream);
    }
    return d;
  }

  private clamped(rec: Rec, n: number): number {
    return rec.index ? clampFrame(rec.index, n) : n;
  }

  /** The frames of `stream` still to decode (union of every demand, minus resident and pending). */
  private wantsFor(rec: Rec): Set<number> {
    const out = new Set<number>();
    const add = (d: Demand | null) => {
      for (const f of d?.frames.get(rec.key) ?? []) {
        const c = this.clamped(rec, f);
        if (!this.lru.has(rec.key, c) && !rec.pending.has(c)) out.add(c);
      }
    };
    add(this.current);
    add(this.ahead);
    for (const e of this.exacts) add(e);
    return out;
  }

  private decoderFor(rec: Rec): StreamDecoder | null {
    if (!rec.index || !rec.bytes) return null;
    if (!rec.dec) {
      rec.dec = new StreamDecoder({
        key: rec.key,
        index: rec.index,
        bytes: rec.bytes,
        env: this.env,
        wants: () => this.wantsFor(rec),
        accept: (n, frame) => this.accept(rec, n, frame),
        onError: (e) => this.failStream(rec.key, e),
      });
    }
    return rec.dec;
  }

  private refresh(streams: Iterable<string>): void {
    for (const s of streams) {
      const rec = this.recs.get(s);
      if (!rec || !rec.index) continue;
      if (this.wantsFor(rec).size === 0) continue;
      this.decoderFor(rec)?.kick();
    }
  }

  private accept(rec: Rec, n: number, frame: VideoFrame): void {
    if (this.disposed) {
      frame.close();
      return;
    }
    if (getUploadMode() === "direct") {
      this.store(rec, n, frame);
      return;
    }
    rec.pending.add(n);
    this.convert(frame).then(
      (bmp) => {
        frame.close();
        rec.pending.delete(n);
        if (this.disposed || this.recs.get(rec.key) !== rec) bmp.close();
        else this.store(rec, n, bmp);
      },
      (e: unknown) => {
        frame.close();
        rec.pending.delete(n);
        this.failStream(rec.key, e instanceof Error ? e : new Error(String(e)));
      },
    );
  }

  private store(rec: Rec, n: number, image: FrameImage): void {
    if (!this.exactMode) {
      const direct = getUploadMode() === "direct";
      this.lru.setCaps(direct ? DIRECT_PER_STREAM : PREVIEW_PER_STREAM, direct ? DIRECT_TOTAL : PREVIEW_TOTAL);
    }
    this.lru.put(rec.key, n, image);
    this.notify();
  }

  private failStream(stream: string, e: Error): void {
    const rec = this.recs.get(stream);
    if (rec) rec.error = e.message;
    this.lastError = `${stream}: ${e.message}`;
    for (const d of [...this.exacts]) {
      if (d.frames.has(stream)) {
        this.exacts.delete(d);
        d.reject(new RenderError("A clip couldn't be decoded", `${stream}: ${e.message}`));
      }
    }
    this.notify();
  }

  private failImage(key: string, e: Error): void {
    this.imageErrors.set(key, e.message);
    this.lastError = `${key}: ${e.message}`;
    for (const d of [...this.exacts]) {
      if (d.images.has(key)) {
        this.exacts.delete(d);
        d.reject(new RenderError("A photo couldn't be loaded", `${key}: ${e.message}`));
      }
    }
    this.notify();
  }

  /** Subscribes to "frames or images arrived"; returns the unsubscribe. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    for (const d of [...this.exacts]) {
      if (this.satisfied(d)) {
        this.exacts.delete(d);
        d.resolve();
      }
    }
    for (const l of [...this.listeners]) l();
  }

  private satisfied(d: Demand): boolean {
    for (const [s, set] of d.frames) {
      const rec = this.recs.get(s);
      if (!rec || !rec.index) return false;
      for (const f of set) if (!this.lru.has(s, this.clamped(rec, f))) return false;
    }
    for (const k of d.images) if (!this.bitmaps.has(k)) return false;
    return true;
  }

  /** True when a key names a photo or image matte rather than a stream. */
  isImageKey(k: string): boolean {
    return k in this.files.images && !(k in this.files.streams);
  }

  /** True when every key is resident (exactly), for the preview's "waiting" count. */
  isReady(keys: readonly FrameKey[]): boolean {
    for (const k of keys) {
      if (k.stream in this.files.streams) {
        const rec = this.recs.get(k.stream);
        if (!rec?.index || !this.lru.has(k.stream, this.clamped(rec, Math.floor(k.frame)))) return false;
      } else if (k.stream in this.files.images && !this.bitmaps.has(k.stream)) return false;
    }
    return true;
  }

  private protectNow(): void {
    const keep = new Set<string>();
    const add = (d: Demand | null) => {
      if (!d) return;
      for (const [s, set] of d.frames) {
        const rec = this.recs.get(s);
        for (const f of set) keep.add(frameKeyString(s, rec ? this.clamped(rec, f) : f));
      }
    };
    add(this.current);
    for (const e of this.exacts) add(e);
    add(this.lastExact);
    this.lru.protect(keep);
  }
  private lastExact: Demand | null = null;

  // ---- FrameProvider ----

  prepare(keys: FrameKey[], exact: boolean, signal?: AbortSignal): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const d = this.group(keys);
    for (const s of d.frames.keys()) this.rec(s);
    const loads = [...d.frames.keys()].map((s) => {
      const rec = this.recs.get(s);
      return rec ? this.loadIndex(rec) : Promise.resolve(null);
    });
    for (const k of d.images) this.loadImage(k);

    if (!exact) {
      this.current = d;
      this.protectNow();
      return Promise.allSettled(loads).then(() => {
        if (this.current === d) {
          this.refresh(d.frames.keys());
          this.protectNow();
        }
      });
    }

    return new Promise<void>((resolve, reject) => {
      const e: ExactDemand = { ...d, resolve, reject, signal };
      if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
      if (signal) {
        e.onAbort = () => {
          this.exacts.delete(e);
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", e.onAbort, { once: true });
      }
      const settle = (fn: () => void) => () => {
        if (signal && e.onAbort) signal.removeEventListener("abort", e.onAbort);
        fn();
      };
      e.resolve = settle(resolve);
      e.reject = (err) => settle(() => reject(err))();
      this.exacts.add(e);
      this.lastExact = d;
      this.protectNow();
      for (const s of d.images) {
        const err = this.imageErrors.get(s);
        if (err) return this.failImage(s, new Error(err));
      }
      Promise.all(loads).then(
        () => {
          if (!this.exacts.has(e)) return;
          if (this.satisfied(e)) {
            this.exacts.delete(e);
            e.resolve();
            return;
          }
          this.refresh(e.frames.keys());
        },
        (err: unknown) => {
          if (!this.exacts.delete(e)) return;
          e.reject(new RenderError("A clip couldn't be read", err instanceof Error ? err.message : String(err)));
        },
      );
    });
  }

  frame(key: FrameKey): FrameImage | null {
    const rec = this.recs.get(key.stream);
    if (!rec?.index) return null;
    const n = this.clamped(rec, Math.max(0, Math.floor(key.frame)));
    const hit = this.lru.get(key.stream, n);
    if (hit) return hit;
    if (this.exactMode) return null;
    return this.lru.nearestBefore(key.stream, n)?.image ?? null;
  }

  image(key: string): ImageBitmap | null {
    const hit = this.bitmaps.get(key);
    if (hit) {
      hit.used = ++this.tick;
      return hit.bmp;
    }
    if (key in this.files.images) this.loadImage(key);
    return null;
  }

  private loadImage(key: string): void {
    if (this.bitmaps.has(key) || this.loading.has(key) || this.imageErrors.has(key) || this.disposed) return;
    const url = this.files.images[key];
    if (!url) return;
    this.imageUrls.set(key, url);
    const p = fetchAll(url, this.fetchImpl)
      .then((b) => this.decodeImage(b))
      .then((bmp) => {
        if (this.disposed || this.files.images[key] !== url) return void bmp.close();
        this.bitmaps.set(key, { bmp, used: ++this.tick });
        this.trimImages(key);
        this.notify();
      })
      .catch((e: unknown) => this.failImage(key, e instanceof Error ? e : new Error(String(e))))
      .finally(() => this.loading.delete(key));
    this.loading.set(key, p);
  }

  private trimImages(except: string): void {
    while (this.bitmaps.size > IMAGE_CAP) {
      let oldest: string | null = null;
      let used = Infinity;
      for (const [k, v] of this.bitmaps) {
        if (k !== except && v.used < used) {
          used = v.used;
          oldest = k;
        }
      }
      if (oldest === null) return;
      this.bitmaps.get(oldest)?.bmp.close();
      this.bitmaps.delete(oldest);
    }
  }

  hint(ahead: FrameKey[], playing: boolean): void {
    if (this.disposed) return;
    this.ahead = playing ? this.group(ahead, getUploadMode() === "direct" ? Math.min(this.aheadN, DIRECT_AHEAD) : this.aheadN) : null;
    if (this.ahead) {
      for (const k of this.ahead.images) this.loadImage(k);
      for (const s of this.ahead.frames.keys()) {
        const rec = this.rec(s);
        if (rec && !rec.index) void this.loadIndex(rec).then(() => this.refresh([s]), () => undefined);
      }
    }
    this.maintain();
    this.refresh(this.recs.keys());
  }

  /** After a fall back to "bitmap", converts the VideoFrames still held. */
  private maintain(): void {
    if (getUploadMode() !== "bitmap") return;
    for (const [s, rec] of this.recs) {
      for (const f of this.lru.frames(s)) {
        const img = this.lru.get(s, f);
        if (!img || !isVideoFrame(img) || rec.pending.has(f)) continue;
        rec.pending.add(f);
        this.convert(img).then(
          (bmp) => {
            rec.pending.delete(f);
            if (!this.lru.replace(s, f, img, bmp)) bmp.close();
            else this.notify();
          },
          () => rec.pending.delete(f),
        );
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of [...this.exacts]) d.reject(new DOMException("Aborted", "AbortError"));
    this.exacts.clear();
    for (const rec of this.recs.values()) rec.dec?.dispose();
    this.recs.clear();
    this.lru.clear();
    for (const v of this.bitmaps.values()) v.bmp.close();
    this.bitmaps.clear();
    this.listeners.clear();
  }

  /** Resident frames per stream, for tests. */
  residentFrames(stream: string): number[] {
    return this.lru.frames(stream).sort((a, b) => a - b);
  }

  /** Total resident decoded frames. */
  get residentCount(): number {
    return this.lru.size;
  }
}
