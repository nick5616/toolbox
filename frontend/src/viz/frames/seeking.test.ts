import { afterEach, describe, expect, it } from "vitest";
import { FrameLRU } from "./cache";
import type { DecoderEnv, VideoDecoderLike } from "./decoder";
import { EditFrameProvider, PREVIEW_MAX_BYTES } from "./provider";
import { averageRGB, sampleBox, samplePixels } from "./sample";
import { filesForQuality, streamForTier } from "./tier";
import type { StreamIndex } from "./types";
import { resetUploadMode, setUploadMode } from "./upload";

// ---- compact fakes (same shapes as frames.test.ts) ----

class FakeFrame {
  closed = 0;
  constructor(readonly timestamp: number) {}
  close(): void {
    this.closed++;
  }
}
class FakeBitmap {
  closed = 0;
  constructor(
    readonly width = 4,
    readonly height = 4,
  ) {}
  close(): void {
    this.closed++;
  }
}

class FakeDecoder implements VideoDecoderLike {
  state = "unconfigured";
  decodeQueueSize = 0;
  constructor(
    private readonly init: { output: (f: VideoFrame) => void },
    private readonly env: FakeEnv,
  ) {}
  configure(): void {
    this.state = "configured";
  }
  decode(chunk: EncodedVideoChunk): void {
    const c = chunk as unknown as { timestamp: number };
    const f = new FakeFrame(c.timestamp);
    this.env.frames.push(f);
    queueMicrotask(() => this.init.output(f as unknown as VideoFrame));
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
  reset(): void {
    this.state = "unconfigured";
  }
  close(): void {
    this.state = "closed";
  }
}
class FakeEnv implements DecoderEnv {
  frames: FakeFrame[] = [];
  createDecoder(init: { output: (frame: VideoFrame) => void; error: (e: Error) => void }): VideoDecoderLike {
    return new FakeDecoder(init, this);
  }
  createChunk(type: "key" | "delta", timestamp: number): EncodedVideoChunk {
    return { type, timestamp } as unknown as EncodedVideoChunk;
  }
}

function makeIndex(frames: number, gop: number): StreamIndex {
  const offsets: number[] = [];
  for (let i = 0; i <= frames; i++) offsets.push(i * 100);
  const keys: number[] = [];
  for (let i = 0; i < frames; i += gop) keys.push(i);
  return { version: 1, codec: "avc1.64001f", width: 4, height: 4, fps: 30, frames, offsets, keys, bytes: frames * 100 };
}

function fakeFetch(files: Record<string, Uint8Array>): typeof fetch {
  return ((url: string, init?: { headers?: Record<string, string> }) => {
    const data = files[url];
    if (!data) return Promise.resolve({ ok: false, status: 404 } as Response);
    const m = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "");
    const start = m ? Number(m[1]) : 0;
    const end = m ? Math.min(data.length, Number(m[2]) + 1) : data.length;
    const body = data.slice(start, end);
    return Promise.resolve({ ok: true, status: 206, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(body.buffer) } as unknown as Response);
  }) as unknown as typeof fetch;
}

function rig(opts: { frames?: number; bitmapSize?: number } = {}) {
  const index = makeIndex(opts.frames ?? 200, 10);
  const env = new FakeEnv();
  const bitmaps: FakeBitmap[] = [];
  const files = { "mem://a.idx": new TextEncoder().encode(JSON.stringify(index)), "mem://a.h264": new Uint8Array(index.bytes) };
  const p = new EditFrameProvider({
    files: { streams: { "v:a": { url: "mem://a.h264", indexUrl: "mem://a.idx" } }, images: {} },
    mode: "preview",
    fetchImpl: fakeFetch(files),
    env,
    convert: () => {
      const b = new FakeBitmap(opts.bitmapSize ?? 4, opts.bitmapSize ?? 4);
      bitmaps.push(b);
      return Promise.resolve(b as unknown as ImageBitmap);
    },
  });
  return { p, env, bitmaps };
}

const key = (frame: number) => ({ stream: "v:a", frame });
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** Lets the decoder pump (timers and microtasks) run until nothing is left to do. */
async function settle(): Promise<void> {
  for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => resetUploadMode());

describe("FrameLRU byte accounting", () => {
  it("evicts past maxBytes, disposes once and keeps the total exact", () => {
    const disposed: string[] = [];
    const lru = new FrameLRU<{ id: string; n: number }>({ perStream: 100, total: 100, maxBytes: 100, bytesOf: (i) => i.n, dispose: (i) => disposed.push(i.id) });
    lru.put("s", 0, { id: "a", n: 40 });
    lru.put("s", 1, { id: "b", n: 40 });
    expect(lru.bytes).toBe(80);
    lru.get("s", 0); // b is now the least recently used
    lru.put("s", 2, { id: "c", n: 40 });
    expect(disposed).toEqual(["b"]);
    expect(lru.bytes).toBe(80);
    const a = lru.get("s", 0) as { id: string; n: number };
    expect(lru.replace("s", 0, a, { id: "a2", n: 10 })).toBe(true);
    expect(lru.bytes).toBe(50);
    lru.put("s", 2, { id: "c2", n: 5 }); // replaces c
    expect(lru.bytes).toBe(15);
    lru.clear();
    expect(lru.bytes).toBe(0);
    expect(disposed.sort()).toEqual(["a", "b", "c", "a2", "c2"].sort());
  });

  it("finds the nearest frame after, for reverse play", () => {
    const lru = new FrameLRU<number>({ perStream: 10, total: 10, dispose: () => undefined });
    lru.put("s", 5, 5);
    lru.put("s", 9, 9);
    expect(lru.nearestAfter("s", 6)?.frame).toBe(9);
    expect(lru.nearestAfter("s", 9)).toBeUndefined();
  });
});

describe("back-step cache", () => {
  it("keeps the current and previous GOP and steps back without a decoder reset", async () => {
    setUploadMode("bitmap");
    const r = rig();
    await r.p.prepare([key(25)], false);
    await settle();
    expect(r.p.residentFrames("v:a")).toEqual(expect.arrayContaining(range(10, 25)));
    const before = r.p.stats()["v:a"] as { resets: number; runs: number };
    for (const n of [24, 23, 22, 21, 20, 19, 18]) {
      await r.p.prepare([key(n)], false);
      expect(r.p.has(key(n))).toBe(true);
      expect(r.p.frame(key(n))).not.toBeNull();
    }
    await settle();
    const after = r.p.stats()["v:a"] as { resets: number; runs: number };
    // Frames 24..18 were all cached: stepping back across the GOP edge made no decode run until the
    // history of the next GOP back was topped up (frames 0..9 only after crossing, never a reset per step).
    expect(after.resets - before.resets).toBeLessThanOrEqual(1);
    r.p.dispose();
  });

  it("closes every VideoFrame and ImageBitmap exactly once", async () => {
    setUploadMode("bitmap");
    const r = rig();
    await r.p.prepare([key(35)], false);
    await settle();
    await r.p.prepare([key(120)], false);
    await settle();
    r.p.readAhead(range(100, 130).map(key));
    await settle();
    r.p.dispose();
    await settle();
    expect(r.env.frames.length).toBeGreaterThan(30);
    for (const f of r.env.frames) expect(f.closed).toBe(1);
    for (const b of r.bitmaps) expect(b.closed).toBe(1);
  });

  it("holds at most 256 MB of decoded frames", async () => {
    setUploadMode("bitmap");
    // 1080p-ish bitmaps: 1920 x 1080 x 4 = 8.3 MB each, so ~31 fit.
    const r = rig({ frames: 400, bitmapSize: 1 });
    void r;
    const lru = new FrameLRU<FakeBitmap>({ perStream: 1000, total: 1000, maxBytes: PREVIEW_MAX_BYTES, bytesOf: (b) => b.width * b.height * 4, dispose: (b) => b.close() });
    const held: FakeBitmap[] = [];
    for (let i = 0; i < 100; i++) {
      const b = new FakeBitmap(1920, 1080);
      held.push(b);
      lru.put("s", i, b);
    }
    expect(lru.bytes).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
    expect(held.filter((b) => b.closed === 0).length).toBe(lru.size);
    lru.clear();
    expect(held.every((b) => b.closed === 1)).toBe(true);
    r.p.dispose();
  });

  it("releaseFrames frees every decoded frame (project close)", async () => {
    setUploadMode("bitmap");
    const r = rig();
    await r.p.prepare([key(12)], false);
    await settle();
    expect(r.p.residentCount).toBeGreaterThan(0);
    r.p.releaseFrames();
    expect(r.p.residentCount).toBe(0);
    expect(r.p.residentBytes).toBe(0);
    await settle();
    for (const b of r.bitmaps) expect(b.closed).toBe(1);
    r.p.dispose();
  });
});

describe("paused read-ahead", () => {
  it("decodes +-0.5 s around the playhead after what's on screen", async () => {
    setUploadMode("bitmap");
    const r = rig();
    await r.p.prepare([key(60)], false);
    await settle();
    expect(r.p.has(key(75))).toBe(false);
    r.p.readAhead(range(45, 75).map(key));
    await settle();
    for (const n of [45, 60, 75]) expect(r.p.has(key(n))).toBe(true);
    expect(r.p.readingAhead).toBe(false);
    r.p.dispose();
  });

  it("is cancelled by a seek but not by redrawing the same frame", async () => {
    setUploadMode("bitmap");
    const r = rig();
    await r.p.prepare([key(60)], false);
    await settle();
    r.p.readAhead(range(45, 75).map(key));
    await r.p.prepare([key(60)], false); // same demand (a redraw): read-ahead continues
    expect(r.p.readingAhead).toBe(true);
    await settle();
    expect(r.p.has(key(75))).toBe(true);

    r.p.readAhead(range(165, 195).map(key));
    await r.p.prepare([key(150)], false); // a seek
    expect(r.p.readingAhead).toBe(false);
    await settle();
    expect(r.p.has(key(195))).toBe(false);
    r.p.dispose();
  });

  it("doesn't start while playing", async () => {
    setUploadMode("bitmap");
    const r = rig();
    await r.p.prepare([key(60)], false);
    r.p.hint([key(61)], true);
    r.p.readAhead(range(45, 75).map(key));
    expect(r.p.readingAhead).toBe(false);
    r.p.dispose();
  });
});

describe("reverse play", () => {
  it("decodes the GOP behind the playhead whole and stands in with the frame after", async () => {
    setUploadMode("bitmap");
    const r = rig();
    r.p.setReverse(true);
    r.p.hint([key(44), key(43)], true);
    await r.p.prepare([key(45)], false);
    await settle();
    for (const n of range(40, 45)) expect(r.p.has(key(n))).toBe(true);
    // A frame that isn't decoded yet is stood in for by the nearest one after it (dropped, not stalled).
    expect(r.p.hasStandIn([key(38)])).toBe(true);
    expect(r.p.frame(key(38))).toBe(r.p.frame(key(40)));
    r.p.setReverse(false);
    expect(r.p.frame(key(38))).toBeNull();
    r.p.dispose();
  });

  it("reaches the previous GOP without resetting per frame", async () => {
    setUploadMode("bitmap");
    const r = rig();
    r.p.setReverse(true);
    let resets = 0;
    for (let n = 95; n >= 60; n--) {
      r.p.hint(range(Math.max(0, n - 15), n - 1).reverse().map(key), true);
      await r.p.prepare([key(n)], false);
      if (n % 5 === 0) await settle();
      resets = (r.p.stats()["v:a"] as { resets: number }).resets;
    }
    await settle();
    // One reset per GOP walked (about 4), never one per frame.
    expect(resets).toBeLessThanOrEqual(12);
    r.p.dispose();
  });
});

describe("stand-ins", () => {
  it("hasStandIn is false until some frame of the stream is decoded", async () => {
    setUploadMode("bitmap");
    const r = rig();
    expect(r.p.hasStandIn([key(5)])).toBe(false);
    await r.p.prepare([key(5)], false);
    await settle();
    expect(r.p.hasStandIn([key(7)])).toBe(true);
    r.p.dispose();
  });
});

describe("preview quality tiers", () => {
  const draft = { streams: { "v:a": { url: "d.h264", indexUrl: "d.idx" }, "v:b": { url: "db.h264", indexUrl: "db.idx" } }, images: { "p:x": "x.png" } };
  const full = { streams: { "v:a": { url: "f.h264", indexUrl: "f.idx" } }, images: {} };

  it("Draft keeps the preview streams, Full swaps in the export streams that exist", () => {
    expect(filesForQuality(draft, full, "draft")).toBe(draft);
    const f = filesForQuality(draft, full, "full");
    expect(f.streams["v:a"]?.url).toBe("f.h264");
    expect(f.streams["v:b"]?.url).toBe("db.h264"); // no export stream: falls back
    expect(f.images).toBe(draft.images);
    expect(filesForQuality(draft, null, "full")).toBe(draft);
  });

  it("streamForTier falls back to the preview stream", () => {
    expect(streamForTier({ preview: "p", export: "e" }, "full")).toBe("e");
    expect(streamForTier({ preview: "p", export: null }, "full")).toBe("p");
    expect(streamForTier({ preview: "p", export: "e" }, "draft")).toBe("p");
    expect(streamForTier(null, "draft")).toBeNull();
  });

  it("switching tiers drops the decoded frames of streams whose URL changed", async () => {
    setUploadMode("bitmap");
    const r = rig();
    await r.p.prepare([key(5)], false);
    await settle();
    expect(r.p.residentCount).toBeGreaterThan(0);
    r.p.setFiles({ streams: { "v:a": { url: "mem://full.h264", indexUrl: "mem://a.idx" } }, images: {} });
    expect(r.p.residentCount).toBe(0);
    await settle();
    for (const b of r.bitmaps) expect(b.closed).toBe(1);
    r.p.dispose();
  });
});

describe("samplePre pixel sampling", () => {
  /** A 16 x 12 test image whose red = x * 10, green = y * 10, blue = 7. */
  const W = 16;
  const H = 12;
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) px.set([x * 10, y * 10, 7, 255], (y * W + x) * 4);
  }
  const reader = (x: number, y: number, w: number, h: number): Uint8Array => {
    const out = new Uint8Array(w * h * 4);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.set(px.subarray(((y + j) * W + x + i) * 4, ((y + j) * W + x + i) * 4 + 4), (j * w + i) * 4);
    return out;
  };

  it("centres a 5 x 5 box on the UV and clamps it inside the image", () => {
    expect(sampleBox(16, 12, 0.5, 0.5)).toEqual({ x: 6, y: 4, w: 5, h: 5 });
    expect(sampleBox(16, 12, 0, 0)).toEqual({ x: 0, y: 0, w: 5, h: 5 });
    expect(sampleBox(16, 12, 1, 1)).toEqual({ x: 11, y: 7, w: 5, h: 5 });
    expect(sampleBox(3, 2, 0.5, 0.5)).toEqual({ x: 0, y: 0, w: 3, h: 2 });
  });

  it("averages the box (a linear gradient averages to its centre)", () => {
    const c = samplePixels(W, H, 0.5, 0.5, reader) as [number, number, number];
    expect(c[0] * 255).toBeCloseTo(80, 5); // x 6..10 -> centre 8 -> 80
    expect(c[1] * 255).toBeCloseTo(60, 5); // y 4..8 -> centre 6 -> 60
    expect(c[2] * 255).toBeCloseTo(7, 5);
  });

  it("returns null for an empty image or a short read", () => {
    expect(samplePixels(0, 0, 0.5, 0.5, reader)).toBeNull();
    expect(samplePixels(W, H, 0.5, 0.5, () => new Uint8Array(4))).toBeNull();
    expect(averageRGB([255, 0, 0, 255], 1)).toEqual([1, 0, 0]);
  });
});

describe("bench (timings are logged, never asserted)", () => {
  it("measures a cached back-step and an uncached one with synthetic decoders", async () => {
    setUploadMode("bitmap");
    const r = rig();
    await r.p.prepare([key(55)], false);
    await settle();
    const t0 = performance.now();
    await r.p.prepare([key(54)], false);
    const cached = performance.now() - t0;
    const hit = r.p.has(key(54));
    const t1 = performance.now();
    await r.p.prepare([key(150)], false);
    await settle();
    const seek = performance.now() - t1;
    // eslint-disable-next-line no-console
    console.info(`[bench] cached back-step ${cached.toFixed(2)} ms (hit=${hit}); far seek incl. settle ${seek.toFixed(1)} ms (budget 16 / 120 ms, SPEC B10)`);
    expect(hit).toBe(true);
    r.p.dispose();
  });
});
