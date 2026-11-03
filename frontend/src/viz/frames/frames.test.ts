import { afterEach, describe, expect, it } from "vitest";
import { RenderError } from "../worker/transport";
import { ByteCache, FrameLRU } from "./cache";
import type { DecoderEnv, VideoDecoderLike } from "./decoder";
import { chooseStart, gopFrames, keyAtOrBefore, parseStreamIndex, planFetch } from "./gop";
import { EditFrameProvider } from "./provider";
import type { StreamIndex } from "./types";
import { resetUploadMode, setUploadMode } from "./upload";

// ---- fakes ----

class FakeFrame {
  closed = 0;
  constructor(readonly timestamp: number) {}
  close(): void {
    this.closed++;
  }
}
class FakeBitmap {
  closed = 0;
  readonly width = 4;
  readonly height = 4;
  close(): void {
    this.closed++;
  }
}

interface FedChunk {
  type: string;
  frame: number;
}

class FakeDecoder implements VideoDecoderLike {
  state = "unconfigured";
  decodeQueueSize = 0;
  fed: FedChunk[] = [];
  configured = 0;
  held: Array<() => void> = [];
  constructor(
    private readonly init: { output: (f: VideoFrame) => void; error: (e: Error) => void },
    private readonly env: FakeEnv,
  ) {}
  configure(): void {
    this.state = "configured";
    this.configured++;
    this.needKey = true;
  }
  private needKey = true;
  decode(chunk: EncodedVideoChunk): void {
    const c = chunk as unknown as { type: string; timestamp: number };
    if (this.env.failAt !== null && c.timestamp % (1 << 22) === this.env.failAt) {
      queueMicrotask(() => this.init.error(new Error("bad bitstream")));
      return;
    }
    if (this.needKey && c.type !== "key") {
      queueMicrotask(() => this.init.error(new Error("a key frame is required")));
      return;
    }
    this.needKey = false;
    this.fed.push({ type: c.type, frame: c.timestamp % (1 << 22) });
    const f = new FakeFrame(c.timestamp);
    this.env.frames.push(f);
    const out = () => this.init.output(f as unknown as VideoFrame);
    if (this.env.hold) this.held.push(out);
    else queueMicrotask(out);
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
  decoders = new Map<number, FakeDecoder>();
  failAt: number | null = null;
  hold = false;
  private n = 0;
  createDecoder(init: { output: (f: VideoFrame) => void; error: (e: Error) => void }): VideoDecoderLike {
    const d = new FakeDecoder(init, this);
    this.decoders.set(this.n++, d);
    return d;
  }
  createChunk(type: "key" | "delta", timestamp: number, data: Uint8Array): EncodedVideoChunk {
    void data;
    return { type, timestamp } as unknown as EncodedVideoChunk;
  }
  get allFed(): FedChunk[] {
    return [...this.decoders.values()].flatMap((d) => d.fed);
  }
  release(): void {
    this.hold = false;
    for (const d of this.decoders.values()) for (const o of d.held.splice(0)) o();
  }
}

function makeIndex(frames: number, gop: number, bytesPerFrame = 100): StreamIndex {
  const offsets: number[] = [];
  for (let i = 0; i <= frames; i++) offsets.push(i * bytesPerFrame);
  const keys: number[] = [];
  for (let i = 0; i < frames; i += gop) keys.push(i);
  return { version: 1, codec: "avc1.64001f", width: 4, height: 4, fps: 30, frames, offsets, keys, bytes: frames * bytesPerFrame };
}

interface Served {
  url: string;
  start: number;
  end: number;
}

function fakeFetch(files: Record<string, Uint8Array>, log: Served[] = []): typeof fetch {
  return ((url: string, init?: { headers?: Record<string, string> }) => {
    const data = files[url];
    if (!data) return Promise.resolve({ ok: false, status: 404 } as Response);
    const m = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "");
    const start = m ? Number(m[1]) : 0;
    const end = m ? Math.min(data.length, Number(m[2]) + 1) : data.length;
    if (start >= data.length) return Promise.resolve({ ok: false, status: 416 } as Response);
    log.push({ url, start, end });
    const body = data.slice(start, end);
    return Promise.resolve({
      ok: true,
      status: 206,
      headers: { get: (h: string) => (h === "Content-Range" ? `bytes ${start}-${end - 1}/${data.length}` : null) },
      arrayBuffer: () => Promise.resolve(body.buffer),
    } as unknown as Response);
  }) as unknown as typeof fetch;
}

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

interface Rig {
  p: EditFrameProvider;
  env: FakeEnv;
  log: Served[];
  bitmaps: FakeBitmap[];
  index: StreamIndex;
}

function rig(opts: { frames?: number; gop?: number; bytes?: number; mode?: "preview" | "export"; images?: Record<string, Uint8Array> } = {}): Rig {
  const index = makeIndex(opts.frames ?? 200, opts.gop ?? 10, opts.bytes ?? 100);
  const log: Served[] = [];
  const bitmaps: FakeBitmap[] = [];
  const env = new FakeEnv();
  const files: Record<string, Uint8Array> = { "mem://a.idx": enc(index), "mem://a.h264": new Uint8Array(index.bytes) };
  const imgs: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.images ?? {})) {
    files[`mem://${k}`] = v;
    imgs[`p:${k}`] = `mem://${k}`;
  }
  const p = new EditFrameProvider({
    files: { streams: { "v:a": { url: "mem://a.h264", indexUrl: "mem://a.idx" } }, images: imgs },
    mode: opts.mode ?? "preview",
    fetchImpl: fakeFetch(files, log),
    env,
    convert: () => {
      const b = new FakeBitmap();
      bitmaps.push(b);
      return Promise.resolve(b as unknown as ImageBitmap);
    },
    decodeImage: () => {
      const b = new FakeBitmap();
      bitmaps.push(b);
      return Promise.resolve(b as unknown as ImageBitmap);
    },
  });
  return { p, env, log, bitmaps, index };
}

const key = (frame: number) => ({ stream: "v:a", frame });

afterEach(() => resetUploadMode());

// ---- pure planning ----

describe("gop planning", () => {
  const idx = makeIndex(35, 10);
  it("finds keys and GOP bounds", () => {
    expect(keyAtOrBefore(idx.keys, 0)).toBe(0);
    expect(keyAtOrBefore(idx.keys, 9)).toBe(0);
    expect(keyAtOrBefore(idx.keys, 10)).toBe(10);
    expect(keyAtOrBefore(idx.keys, 34)).toBe(30);
    expect(gopFrames(idx, 12)).toEqual({ first: 10, last: 19 });
    expect(gopFrames(idx, 34)).toEqual({ first: 30, last: 34 });
  });

  it("continues forward within two GOPs, else resets to the key", () => {
    expect(chooseStart(idx.keys, 5, -1)).toEqual({ start: 0, reset: true });
    expect(chooseStart(idx.keys, 5, 4)).toEqual({ start: 5, reset: false });
    expect(chooseStart(idx.keys, 12, 4)).toEqual({ start: 5, reset: false });
    expect(chooseStart(idx.keys, 25, 4)).toEqual({ start: 5, reset: false });
    expect(chooseStart(idx.keys, 31, 4)).toEqual({ start: 30, reset: true });
    expect(chooseStart(idx.keys, 3, 4)).toEqual({ start: 0, reset: true });
  });

  it("plans whole-GOP Range groups of at most 4 MiB", () => {
    const big = makeIndex(300, 10, 40_000); // 400 kB per GOP, 120 MB total
    const groups = planFetch(big, 25, 130, 4 * 1024 * 1024);
    expect(groups[0]?.firstFrame).toBe(20);
    expect(groups[groups.length - 1]?.lastFrame).toBe(139);
    for (const g of groups) {
      expect(g.end - g.start).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(big.keys).toContain(g.firstFrame);
    }
    for (let i = 1; i < groups.length; i++) expect((groups[i] as { start: number }).start).toBe((groups[i - 1] as { end: number }).end);
  });

  it("splits a GOP bigger than the limit by bytes", () => {
    const huge = makeIndex(20, 10, 1_000_000); // 10 MB GOPs
    const groups = planFetch(huge, 0, 5, 4 * 1024 * 1024);
    expect(groups.length).toBe(3);
    expect(groups.every((g) => g.end - g.start <= 4 * 1024 * 1024)).toBe(true);
    expect(groups[0]?.start).toBe(0);
    expect(groups[2]?.end).toBe(10_000_000);
  });

  it("rejects bad indexes", () => {
    expect(() => parseStreamIndex({ ...idx, version: 2 })).toThrow(/version/);
    expect(() => parseStreamIndex({ ...idx, offsets: [0, 1] })).toThrow(/offsets/);
    expect(() => parseStreamIndex({ ...idx, keys: [3] })).toThrow(/key frame/);
    expect(parseStreamIndex(idx).frames).toBe(35);
  });
});

describe("caches", () => {
  it("ByteCache evicts the least recently used segment past its limit", () => {
    const c = new ByteCache(250);
    c.put(0, new Uint8Array(100));
    c.put(100, new Uint8Array(100));
    expect(c.slice(0, 10)).not.toBeNull(); // touch segment 0
    c.put(200, new Uint8Array(100));
    expect(c.has(100, 200)).toBe(false);
    expect(c.has(0, 100)).toBe(true);
    expect(c.has(200, 300)).toBe(true);
    expect(c.slice(50, 150)).toBeNull();
    c.put(100, new Uint8Array(100).fill(7));
    expect(c.slice(90, 110)?.length).toBe(20); // stitched across segments
  });

  it("FrameLRU enforces the caps, protects keys and disposes each image once", () => {
    const closed = new Map<object, number>();
    const mk = () => {
      const o = {};
      closed.set(o, 0);
      return o;
    };
    const lru = new FrameLRU<object>({ perStream: 3, total: 5, dispose: (o) => closed.set(o, (closed.get(o) ?? 0) + 1) });
    const imgs = Array.from({ length: 8 }, mk);
    for (let i = 0; i < 4; i++) lru.put("a", i, imgs[i] as object);
    expect(lru.sizeOf("a")).toBe(3);
    expect(closed.get(imgs[0] as object)).toBe(1);
    lru.protect(new Set(["a#1"]));
    lru.put("a", 4, imgs[4] as object);
    lru.put("a", 5, imgs[5] as object);
    expect(lru.has("a", 1)).toBe(true);
    for (let i = 0; i < 3; i++) lru.put("b", i, mk());
    expect(lru.size).toBeLessThanOrEqual(5 + 1); // protected frame may keep it one over
    expect(lru.nearestBefore("a", 100)?.frame).toBeGreaterThan(3);
    lru.put("a", 5, imgs[6] as object); // replacing disposes the old one
    expect(closed.get(imgs[5] as object)).toBe(1);
    lru.clear();
    for (const i of [0, 1, 2, 3, 4, 5, 6]) expect(closed.get(imgs[i] as object)).toBe(1);
  });
});

// ---- provider ----

describe("EditFrameProvider", () => {
  for (const mode of ["direct", "bitmap"] as const) {
    describe(`${mode} upload`, () => {
      it("decodes exactly what was asked and closes every frame exactly once", async () => {
        setUploadMode(mode);
        const r = rig();
        await r.p.prepare([key(3), key(4)], true);
        expect(r.p.frame(key(3))).not.toBeNull();
        expect(r.p.frame(key(4))).not.toBeNull();
        await r.p.prepare([key(95)], true);
        expect(r.p.frame(key(95))).not.toBeNull();
        r.p.dispose();
        await Promise.resolve();
        await Promise.resolve();
        expect(r.env.frames.length).toBeGreaterThan(0);
        if (mode === "direct") for (const f of r.env.frames) expect(f.closed).toBe(1);
        else {
          for (const f of r.env.frames) expect(f.closed).toBe(1);
          for (const b of r.bitmaps) expect(b.closed).toBe(1);
        }
      });
    });
  }

  it("reuses the decoder going forward and resets on a seek", async () => {
    setUploadMode("bitmap");
    const r = rig();
    await r.p.prepare([key(3)], true);
    await r.p.prepare([key(4)], true);
    await r.p.prepare([key(8)], true);
    const first = r.env.allFed.map((c) => c.frame);
    expect(first).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]); // never re-fed
    expect(r.p.stats()["v:a"]?.resets).toBe(1);
    await r.p.prepare([key(95)], true); // seek back-and-far: reset to key 90
    const fed = r.env.allFed.map((c) => c.frame);
    expect(fed.slice(9)).toEqual([90, 91, 92, 93, 94, 95]);
    expect(r.p.stats()["v:a"]?.resets).toBe(2);
    await r.p.prepare([key(2)], true); // backwards: reset to key 0
    expect(r.env.allFed.slice(-3).map((c) => c.frame)).toEqual([0, 1, 2]);
    expect(r.env.allFed.every((c) => (c.frame % 10 === 0 ? c.type === "key" : c.type === "delta"))).toBe(true);
    r.p.dispose();
  });

  it("continues across a GOP boundary without a reset", async () => {
    setUploadMode("bitmap");
    const r = rig();
    await r.p.prepare([key(8)], true);
    await r.p.prepare([key(14)], true);
    expect(r.p.stats()["v:a"]?.resets).toBe(1);
    expect(r.env.allFed.map((c) => c.frame)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    r.p.dispose();
  });

  it("exact prepare waits for the decoder", async () => {
    setUploadMode("bitmap");
    const r = rig();
    r.env.hold = true;
    let done = false;
    const pr = r.p.prepare([key(2)], true).then(() => (done = true));
    for (let i = 0; i < 20; i++) await new Promise((res) => setTimeout(res, 1));
    expect(done).toBe(false);
    expect(r.p.frame(key(2))).toBeNull();
    r.env.release();
    await pr;
    expect(done).toBe(true);
    expect(r.p.frame(key(2))).not.toBeNull();
    r.p.dispose();
  });

  it("inexact: nearest earlier frame, or null; export never substitutes", async () => {
    setUploadMode("bitmap");
    const r = rig();
    await r.p.prepare([key(2), key(3)], true);
    const f3 = r.p.frame(key(3));
    expect(r.p.frame(key(7))).toBe(f3); // preview: the nearest earlier decoded frame
    expect(r.p.frame({ stream: "v:a", frame: 1 })).toBeNull(); // nothing earlier than 2 was kept
    expect(r.p.frame({ stream: "v:none", frame: 0 })).toBeNull();
    r.p.dispose();
    const x = rig({ mode: "export" });
    await x.p.prepare([key(2)], true);
    expect(x.p.frame(key(3))).toBeNull();
    expect(x.p.frame(key(2))).not.toBeNull();
    x.p.dispose();
  });

  it("holds the last frame past the end of the stream", async () => {
    setUploadMode("bitmap");
    const r = rig({ frames: 30 });
    await r.p.prepare([key(500)], true);
    expect(r.p.frame(key(500))).toBe(r.p.frame(key(29)));
    expect(r.p.frame(key(29))).not.toBeNull();
    r.p.dispose();
  });

  it("caps frames per stream (preview 24, export 8) and closes the evicted ones", async () => {
    setUploadMode("bitmap");
    const r = rig({ frames: 100 });
    for (let i = 0; i < 40; i++) await r.p.prepare([key(i)], true);
    expect(r.p.residentFrames("v:a").length).toBeLessThanOrEqual(24);
    expect(r.p.frame(key(39))).not.toBeNull();
    const evicted = r.bitmaps.filter((b) => b.closed === 1).length;
    expect(evicted).toBe(40 - r.p.residentFrames("v:a").length);
    r.p.dispose();

    const x = rig({ frames: 100, mode: "export" });
    for (let i = 0; i < 20; i++) await x.p.prepare([key(i)], true);
    expect(x.p.residentFrames("v:a").length).toBeLessThanOrEqual(8);
    x.p.dispose();
  });

  it("keeps the frames of the current exact prepare resident", async () => {
    setUploadMode("bitmap");
    const x = rig({ frames: 100, mode: "export" });
    const keys = Array.from({ length: 10 }, (_, i) => key(i)); // more than the per-stream cap
    await x.p.prepare(keys, true);
    for (const k of keys) expect(x.p.frame(k)).not.toBeNull();
    x.p.dispose();
  });

  it("reads Range requests of at most 4 MiB, aligned to key frames", async () => {
    setUploadMode("bitmap");
    const r = rig({ frames: 200, gop: 10, bytes: 100_000 }); // 20 MB, GOPs of 1 MB
    await r.p.prepare([key(95)], true);
    const reqs = r.log.filter((s) => s.url === "mem://a.h264");
    expect(reqs.length).toBeGreaterThan(0);
    for (const s of reqs) {
      expect(s.end - s.start).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(s.start % 1_000_000).toBe(0);
    }
    r.p.dispose();
  });

  it("rejects exact prepares with a RenderError when decoding fails", async () => {
    setUploadMode("bitmap");
    const r = rig();
    r.env.failAt = 3;
    await expect(r.p.prepare([key(5)], true)).rejects.toBeInstanceOf(RenderError);
    r.p.dispose();
  });

  it("rejects when the index can't be read", async () => {
    setUploadMode("bitmap");
    const p = new EditFrameProvider({ files: { streams: { "v:x": { url: "mem://x", indexUrl: "mem://missing" } }, images: {} }, mode: "export", fetchImpl: fakeFetch({}), env: new FakeEnv() });
    await expect(p.prepare([{ stream: "v:x", frame: 0 }], true)).rejects.toBeInstanceOf(RenderError);
    p.dispose();
  });

  it("aborts a waiting prepare", async () => {
    setUploadMode("bitmap");
    const r = rig();
    r.env.hold = true;
    const ac = new AbortController();
    const pr = r.p.prepare([key(2)], true, ac.signal);
    ac.abort();
    await expect(pr).rejects.toThrow(/abort/i);
    r.env.release();
    r.p.dispose();
  });

  it("decodes ahead while playing and notifies listeners", async () => {
    setUploadMode("bitmap");
    const r = rig();
    let arrived = 0;
    r.p.onChange(() => arrived++);
    await r.p.prepare([key(0)], false);
    r.p.hint(Array.from({ length: 20 }, (_, i) => key(i)), true);
    for (let i = 0; i < 30; i++) await new Promise((res) => setTimeout(res, 1));
    expect(r.p.residentFrames("v:a").length).toBeGreaterThanOrEqual(15);
    expect(arrived).toBeGreaterThan(0);
    expect(r.p.isReady([key(0), key(10)])).toBe(true);
    // paused: no further decode-ahead is requested
    r.p.hint([key(150), key(151)], false);
    for (let i = 0; i < 10; i++) await new Promise((res) => setTimeout(res, 1));
    expect(r.p.isReady([key(150)])).toBe(false);
    r.p.dispose();
  });

  it("loads photos as frames of an images key", async () => {
    setUploadMode("bitmap");
    const r = rig({ images: { "photo.jpg": new Uint8Array([1, 2, 3]) } });
    expect(r.p.image("p:photo.jpg")).toBeNull(); // first ask starts the load
    await r.p.prepare([{ stream: "p:photo.jpg", frame: 0 }], true);
    expect(r.p.image("p:photo.jpg")).not.toBeNull();
    r.p.dispose();
    expect(r.bitmaps.every((b) => b.closed === 1)).toBe(true);
  });
});

describe("upload mode", () => {
  it("falls back to bitmap when direct upload can't be probed, and stays there", async () => {
    const up = await import("./upload");
    expect(up.getUploadMode()).toBe(up.DEFAULT_UPLOAD_MODE);
    expect(up.initUploadMode({} as WebGL2RenderingContext)).toBe("bitmap"); // jsdom has no VideoFrame
    expect(up.uploadReason()).toMatch(/probe/);
    expect(up.initUploadMode({} as WebGL2RenderingContext)).toBe("bitmap"); // probed once
    resetUploadMode();
    setUploadMode("direct");
    up.fallBackToBitmap("texImage2D(VideoFrame) failed");
    expect(up.getUploadMode()).toBe("bitmap");
  });
});
