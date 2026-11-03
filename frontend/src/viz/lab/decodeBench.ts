/**
 * The decode bench (Phase 9 SPEC §16.1, §22.8): `TOOLBOX_VIZLAB=1
 * TOOLBOX_VIEW=vizlab TOOLBOX_VIZLAB_ARGS="decode=1"`. Measures, on the main
 * thread and in a worker:
 *  1. decode fps for 1 and 4 simultaneous streams at 540p and 1080p, played
 *     sequentially and with random seeks (reset + decode from the key frame);
 *  2. the cost of texImage2D(VideoFrame) against createImageBitmap(frame) +
 *     texImage2D(bitmap);
 *  3. how many decoded frames can be held open before the decoder stalls.
 * Writes decode.json (with the decision rule's recommendation) through the
 * vzlab| sink. Streams are generated with WebCodecs, GOP 10, no B-frames.
 *
 * No Wails imports: the worker side runs `benchCore` too.
 */
import { REAL_ENV } from "../frames/decoder";
import type { StreamIndex } from "../frames/types";
import { encodeSyntheticStream, type SynthStream } from "./synth";


export interface SeekResult {
  seeks: number;
  msPerSeek: number;
  /** Frames fed to the decoder per second of wall time while seeking. */
  fedPerSecond: number;
}

export interface UploadResult {
  frames: number;
  directMsPerFrame: number | null;
  directError: string;
  bitmapMsPerFrame: number | null;
}

export interface HoldResult {
  held: number;
  ok: boolean;
  outputs: number;
  expected: number;
}

export interface SizeResult {
  size: string;
  sequentialFps: Record<string, number>;
  seek: Record<string, SeekResult>;
  upload: UploadResult;
}

export interface CoreResult {
  where: "main" | "worker";
  sizes: SizeResult[];
  hold: HoldResult[];
  /** The smallest number of held frames that stalled the decoder, or null if none did. */
  holdStall: number | null;
  error: string;
}

const TIMEOUT_MS = 8000;
const now = () => performance.now();

class Session {
  readonly decoder: VideoDecoder;
  outputs = 0;
  private waiters = new Map<number, () => void>();
  private seen = new Set<number>();
  error: Error | null = null;

  constructor(
    readonly index: StreamIndex,
    private readonly onFrame: (f: VideoFrame, n: number) => void,
  ) {
    this.decoder = new VideoDecoder({
      output: (f) => {
        const n = f.timestamp;
        this.outputs++;
        this.seen.add(n);
        this.onFrame(f, n);
        this.waiters.get(n)?.();
      },
      error: (e) => {
        this.error = e instanceof Error ? e : new Error(String(e));
        for (const w of this.waiters.values()) w();
      },
    });
    this.configure();
  }

  configure(): void {
    this.decoder.configure({ codec: this.index.codec, codedWidth: this.index.width, codedHeight: this.index.height, optimizeForLatency: true });
  }

  feed(bytes: Uint8Array, n: number): void {
    const isKey = this.index.keys.includes(n);
    const [a, b] = [this.index.offsets[n] as number, this.index.offsets[n + 1] as number];
    this.decoder.decode(REAL_ENV.createChunk(isKey ? "key" : "delta", n, bytes.subarray(a, b)));
  }

  /** Resolves true when the output with timestamp n arrived, false on timeout or error. */
  waitFor(n: number, ms = TIMEOUT_MS): Promise<boolean> {
    if (this.seen.has(n)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const t = setTimeout(() => {
        this.waiters.delete(n);
        resolve(false);
      }, ms);
      this.waiters.set(n, () => {
        clearTimeout(t);
        this.waiters.delete(n);
        resolve(!this.error);
      });
    });
  }

  reset(): void {
    this.decoder.reset();
    this.seen.clear();
    this.configure();
  }

  close(): void {
    if (this.decoder.state !== "closed") this.decoder.close();
  }
}

async function sequential(s: SynthStream): Promise<number> {
  const sess = new Session(s.index, (f) => f.close());
  const t0 = now();
  for (let i = 0; i < s.index.frames; i++) {
    sess.feed(s.bytes, i);
    while (sess.decoder.decodeQueueSize > 6) await new Promise((r) => setTimeout(r, 0));
  }
  const ok = await sess.waitFor(s.index.frames - 1);
  const ms = now() - t0;
  sess.close();
  if (!ok) throw new Error(sess.error?.message ?? "sequential decode timed out");
  return ms;
}

/** A small seeded sequence so every run seeks to the same frames. */
function targets(frames: number, n: number): number[] {
  let x = 12345;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out.push(10 + (x % Math.max(1, frames - 10)));
  }
  return out;
}

async function seeking(s: SynthStream, count: number): Promise<{ ms: number; fed: number }> {
  const sess = new Session(s.index, (f) => f.close());
  let fed = 0;
  const t0 = now();
  for (const target of targets(s.index.frames, count)) {
    sess.reset();
    const key = s.index.keys.filter((k) => k <= target).pop() ?? 0;
    for (let i = key; i <= target; i++) {
      sess.feed(s.bytes, i);
      fed++;
    }
    if (!(await sess.waitFor(target))) {
      sess.close();
      throw new Error(sess.error?.message ?? "seek timed out");
    }
  }
  const ms = now() - t0;
  sess.close();
  return { ms, fed };
}

async function uploadCost(s: SynthStream): Promise<UploadResult> {
  const held: VideoFrame[] = [];
  const sess = new Session(s.index, (f) => held.push(f));
  const n = 8;
  for (let i = 0; i < n; i++) sess.feed(s.bytes, i);
  await sess.waitFor(n - 1);
  const canvas = new OffscreenCanvas(16, 16);
  const gl = canvas.getContext("webgl2");
  if (!gl) {
    for (const f of held) f.close();
    sess.close();
    return { frames: 0, directMsPerFrame: null, directError: "no WebGL2", bitmapMsPerFrame: null };
  }
  const tex = gl.createTexture();
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  const reps = 3;
  const res: UploadResult = { frames: held.length * reps, directMsPerFrame: null, directError: "", bitmapMsPerFrame: null };
  gl.bindTexture(gl.TEXTURE_2D, tex);
  try {
    const t0 = now();
    for (let r = 0; r < reps; r++) for (const f of held) gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, f);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    sync();
    res.directMsPerFrame = (now() - t0) / res.frames;
    if (gl.getError() !== gl.NO_ERROR) {
      res.directError = "texImage2D(VideoFrame) raised a GL error";
      res.directMsPerFrame = null;
    }
  } catch (e) {
    res.directError = e instanceof Error ? e.message : String(e);
  }
  try {
    const t0 = now();
    for (let r = 0; r < reps; r++) {
      for (const f of held) {
        const bmp = await createImageBitmap(f);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
        bmp.close();
      }
    }
    sync();
    res.bitmapMsPerFrame = (now() - t0) / res.frames;
  } catch {
    res.bitmapMsPerFrame = null;
  }
  for (const f of held) f.close();
  sess.close();
  return res;
}

async function holdTest(s: SynthStream, held: number): Promise<HoldResult> {
  const keep: VideoFrame[] = [];
  const sess = new Session(s.index, (f) => {
    if (keep.length < held) keep.push(f);
    else f.close();
  });
  const expected = Math.min(s.index.frames, held + 30);
  for (let i = 0; i < expected; i++) sess.feed(s.bytes, i);
  const ok = await sess.waitFor(expected - 1, 3000);
  const outputs = sess.outputs;
  for (const f of keep) f.close();
  sess.close();
  return { held, ok, outputs, expected };
}

/** Runs every measurement on a prepared set of streams (4 per size, keyed by the short side). */
export async function benchCore(streams: Record<string, SynthStream[]>, where: "main" | "worker", say: (s: string) => void): Promise<CoreResult> {
  const out: CoreResult = { where, sizes: [], hold: [], holdStall: null, error: "" };
  try {
    for (const [size, list] of Object.entries(streams)) {
      const first = list[0] as SynthStream;
      const r: SizeResult = { size, sequentialFps: {}, seek: {}, upload: { frames: 0, directMsPerFrame: null, directError: "", bitmapMsPerFrame: null } };
      for (const k of [1, 4]) {
        say(`${where} ${size}p: ${k} stream(s) sequential`);
        const set = list.slice(0, k);
        const t0 = now();
        await Promise.all(set.map((s) => sequential(s)));
        r.sequentialFps[String(k)] = Math.round(((set.length * first.index.frames) / ((now() - t0) / 1000)) * 10) / 10;
        say(`${where} ${size}p: ${k} stream(s) seeking`);
        const count = 24;
        const t1 = now();
        const res = await Promise.all(set.map((s) => seeking(s, count)));
        const secs = (now() - t1) / 1000;
        r.seek[String(k)] = { seeks: count * set.length, msPerSeek: Math.round(((secs * 1000) / count) * 10) / 10, fedPerSecond: Math.round((res.reduce((n, x) => n + x.fed, 0) / secs) * 10) / 10 };
      }
      say(`${where} ${size}p: upload`);
      r.upload = await uploadCost(first);
      out.sizes.push(r);
    }
    const small = Object.values(streams)[0]?.[0];
    if (small) {
      for (const k of [4, 8, 12, 16, 24, 32]) {
        say(`${where}: holding ${k} frames`);
        const h = await holdTest(small, k);
        out.hold.push(h);
        if (!h.ok) {
          out.holdStall = k;
          break;
        }
      }
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  return out;
}

/** SPEC §16.1: keep the VideoFrame and upload directly if that works and is at least 20 % faster; else ImageBitmap. */
export function recommend(results: CoreResult[]): { upload: "direct" | "bitmap"; why: string } {
  const ups = results.flatMap((r) => r.sizes.map((s) => s.upload));
  if (ups.length === 0) return { upload: "bitmap", why: "no upload measurements" };
  if (ups.some((u) => u.directMsPerFrame === null)) return { upload: "bitmap", why: `direct upload failed (${ups.find((u) => u.directError)?.directError ?? "unknown"})` };
  const faster = ups.every((u) => u.bitmapMsPerFrame !== null && (u.directMsPerFrame as number) <= 0.8 * u.bitmapMsPerFrame);
  const stalled = results.find((r) => r.holdStall !== null && r.holdStall <= 12);
  if (!faster) return { upload: "bitmap", why: "direct upload is not at least 20 % faster" };
  if (stalled) return { upload: "bitmap", why: `the decoder stalled holding ${stalled.holdStall} frames (${stalled.where})` };
  return { upload: "direct", why: "direct upload works and is at least 20 % faster" };
}

function runInWorker(streams: Record<string, SynthStream[]>): Promise<CoreResult> {
  return new Promise((resolve) => {
    const w = new Worker(new URL("./decodeBench.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<CoreResult>) => {
      w.terminate();
      resolve(e.data);
    };
    w.onerror = (e) => {
      w.terminate();
      resolve({ where: "worker", sizes: [], hold: [], holdStall: null, error: e.message || "the worker failed" });
    };
    w.postMessage({ streams });
  });
}

/** `decode=1`: generates the streams, runs the bench on the main thread and in a worker, writes decode.json. */
export async function runDecodeBench(say: (s: string) => void, sendJSON: (name: string, v: unknown) => void): Promise<void> {
  const out: Record<string, unknown> = { userAgent: navigator.userAgent, startedAt: new Date().toISOString() };
  try {
    const streams: Record<string, SynthStream[]> = {};
    for (const [short, long] of [
      [540, 960],
      [1080, 1920],
    ] as const) {
      say(`encoding 4 × ${short}x${long}…`);
      const list: SynthStream[] = [];
      for (let i = 0; i < 4; i++) list.push(await encodeSyntheticStream({ width: short, height: long, fps: 30, frames: 90, gop: 10, hue: i * 80 }));
      streams[String(short)] = list;
    }
    const main = await benchCore(streams, "main", say);
    const worker = await runInWorker(streams);
    out.main = main;
    out.worker = worker;
    out.recommended = recommend([main, worker]);
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  out.finishedAt = new Date().toISOString();
  sendJSON("decode.json", out);
  say("decode bench done");
}
