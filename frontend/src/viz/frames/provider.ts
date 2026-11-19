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
import { clampFrame, gopFrames, parseStreamIndex } from "./gop";
import { StreamBytes } from "./source";
import type { FrameImage, FrameKey, FrameProvider, StreamIndex, StreamRef } from "./types";
import { getUploadMode, imageSize, isVideoFrame } from "./upload";

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

/** Current + previous GOP (10 frames each) + +-0.5 s read-ahead fit one stream. */
export const PREVIEW_PER_STREAM = 48;
export const PREVIEW_TOTAL = 400;
/** The back-step cache's memory cap (SPEC B5): decoded frames of all streams together. */
export const PREVIEW_MAX_BYTES = 256 * 1024 * 1024;
/** Paused read-ahead reaches this many frames each side of the playhead (+-0.5 s at 30 fps). */
export const READ_AHEAD_FRAMES = 15;
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

function sameDemand(a: Demand | null, b: Demand): boolean {
  if (!a || a.frames.size !== b.frames.size || a.images.size !== b.images.size) return false;
  for (const [s, set] of b.frames) {
    const o = a.frames.get(s);
    if (!o || o.size !== set.size) return false;
    for (const f of set) if (!o.has(f)) return false;
  }
  return true;
}

const defaultConvert = (f: VideoFrame): Promise<ImageBitmap> => createImageBitmap(f);
const defaultDecodeImage = (b: Uint8Array): Promise<ImageBitmap> => createImageBitmap(new Blob([b as BlobPart]));

function disposeImage(img: FrameImage): void {
  img.close();
}

function imageBytes(img: FrameImage): number {
  const { w, h } = imageSize(img);
  return w * h * 4;
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
  /** Paused read-ahead (B5): low priority, dropped by the next prepare (a seek). */
  private idle: Demand | null = null;
  /** The current GOP and the one before are kept for back-stepping while paused. */
  private historyOn = false;
  private playing = false;
  private reverse = false;
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
      ...(this.exactMode ? {} : { maxBytes: PREVIEW_MAX_BYTES, bytesOf: imageBytes }),
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
    // Back-step history and idle read-ahead wait until what's on screen is decoded.
    if (!this.exactMode && this.currentResident(rec)) {
      if (this.historyOn && this.current) {
        for (const f of this.current.frames.get(rec.key) ?? []) {
          for (const h of this.historyFrames(rec, this.clamped(rec, f))) if (!this.lru.has(rec.key, h) && !rec.pending.has(h)) out.add(h);
        }
      }
      add(this.idle);
    }
    if (this.reverse && this.ahead) {
      for (const f of this.ahead.frames.get(rec.key) ?? []) {
        for (const h of this.gopPrefix(rec, this.clamped(rec, f))) if (!this.lru.has(rec.key, h) && !rec.pending.has(h)) out.add(h);
      }
    }
    return out;
  }

  /** Frames first..n of n's GOP (decoded on the way to n anyway). */
  private gopPrefix(rec: Rec, n: number): number[] {
    if (!rec.index) return [n];
    const { first } = gopFrames(rec.index, n);
    const out: number[] = [];
    for (let i = first; i <= n; i++) out.push(i);
    return out;
  }

  /** The frames a back-step from n needs: its GOP up to n and the whole GOP before. */
  private historyFrames(rec: Rec, n: number): number[] {
    if (!rec.index) return [];
    const { first } = gopFrames(rec.index, n);
    const out: number[] = [];
    if (first > 0) {
      const prev = gopFrames(rec.index, first - 1);
      for (let i = prev.first; i <= prev.last; i++) out.push(i);
    }
    for (let i = first; i <= n; i++) out.push(i);
    return out;
  }

  /** True when every frame the on-screen demand needs of this stream is resident. */
  private currentResident(rec: Rec): boolean {
    for (const f of this.current?.frames.get(rec.key) ?? []) if (!this.lru.has(rec.key, this.clamped(rec, f))) return false;
    return true;
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
    if (rec.error) {
      // the stream recovered (a retry after a failure)
      rec.error = "";
      if (this.lastError.startsWith(`${rec.key}: `)) this.lastError = "";
    }
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
      if (!sameDemand(this.current, d)) this.idle = null; // any seek cancels read-ahead
      this.current = d;
      this.historyOn = !this.playing;
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
    return this.standIn(key.stream, n)?.image ?? null;
  }

  private standIn(stream: string, n: number): { frame: number; image: FrameImage } | undefined {
    const before = this.lru.nearestBefore(stream, n);
    if (!this.reverse) return before;
    return this.lru.nearestAfter(stream, n) ?? before;
  }

  /** True when every stream key has its frame or a stand-in (so drawing won't leave a hole). */
  hasStandIn(keys: readonly FrameKey[]): boolean {
    for (const k of keys) {
      if (k.stream in this.files.streams) {
        const rec = this.recs.get(k.stream);
        if (!rec?.index) return false;
        const n = this.clamped(rec, Math.max(0, Math.floor(k.frame)));
        if (!this.lru.has(k.stream, n) && !this.standIn(k.stream, n)) return false;
      } else if (k.stream in this.files.images && !this.bitmaps.has(k.stream)) return false;
    }
    return true;
  }

  /**
   * Paused read-ahead (SPEC B5): keys around the playhead for the visible
   * clips, decoded after what's on screen. The next prepare (a seek) cancels it.
   */
  readAhead(keys: FrameKey[]): void {
    if (this.disposed || this.exactMode || this.playing) return;
    const d = this.group(keys, PREVIEW_PER_STREAM);
    this.idle = d;
    for (const s of d.frames.keys()) {
      const rec = this.rec(s);
      if (rec && !rec.index) void this.loadIndex(rec).then(() => this.refresh([s]), () => undefined);
    }
    this.refresh(d.frames.keys());
  }

  /** True while read-ahead frames are still to be decoded (tests). */
  get readingAhead(): boolean {
    if (!this.idle) return false;
    for (const rec of this.recs.values()) {
      for (const f of this.idle.frames.get(rec.key) ?? []) if (!this.lru.has(rec.key, this.clamped(rec, f))) return true;
    }
    return false;
  }

  /** Reverse play (J): stand-ins come from frames after the playhead, and each GOP behind it is decoded whole. */
  setReverse(on: boolean): void {
    this.reverse = on;
  }

  /** True when a frame is resident (exact), for tests and the back-step check. */
  has(key: FrameKey): boolean {
    const rec = this.recs.get(key.stream);
    return !!rec?.index && this.lru.has(key.stream, this.clamped(rec, Math.max(0, Math.floor(key.frame))));
  }

  /** Bytes the decoded-frame cache holds. */
  get residentBytes(): number {
    return this.lru.bytes;
  }

  /** Releases every decoded frame now (project close); the provider stays usable. */
  releaseFrames(): void {
    this.lru.clear();
    this.current = null;
    this.ahead = null;
    this.idle = null;
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
    this.playing = playing;
    if (playing) {
      this.historyOn = false;
      this.idle = null;
    }
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
