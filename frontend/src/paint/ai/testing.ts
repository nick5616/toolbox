// Test doubles for the perception queue: a fake PaintEngine (one pixel layer,
// real undo-free semantics for readRegion/writeRegion) and fake AIDeps (jobs
// you can finish, fail or hold). Used by this folder's tests and available to
// P5's component tests.

import type { PaintAIRequest } from "@/lib/api";
import type { HistoryEntry, HistoryId, PaintEngine, Rect } from "../engine/types";
import type { AIDeps, ImageCodec, JobLike } from "./deps";
import { cloneImage, createImage, cropImage, featherAlpha } from "./pixels";

export interface WriteCall {
  layerId: string;
  r: Rect;
  img: ImageData;
  mask?: ImageData;
  feather?: number;
  label?: string;
  id: HistoryId;
}

export interface FakeEngine extends PaintEngine {
  /** The pixels of the single layer (canvas sized). */
  pixels: ImageData;
  writes: WriteCall[];
  /** Simulates the user painting `color` into r on the active layer (adds a history entry). */
  paint(r: Rect, color: [number, number, number, number]): void;
  selected: Array<{ mask: ImageData; at: { x: number; y: number }; mode?: string }>;
}

export function createFakeEngine(w: number, h: number, fill: [number, number, number, number] = [10, 20, 30, 255]): FakeEngine {
  const pixels = createImage(w, h);
  for (let i = 0; i < w * h; i++) pixels.data.set(fill, i * 4);
  const hist: HistoryEntry[] = [];
  const writes: WriteCall[] = [];
  const selected: FakeEngine["selected"] = [];
  const doc = { width: w, height: h, active: "L1", layers: [{ id: "L1", name: "Layer 1", hidden: false }] };
  let nextId = 1;

  const eng = {
    doc,
    pixels,
    writes,
    selected,
    selection: {
      fromMask(mask: ImageData, at: { x: number; y: number }, mode?: string) {
        selected.push({ mask, at, mode });
      },
    },
    async readRegion(r: Rect) {
      return cropImage(eng.pixels, r);
    },
    writeRegion(layerId: string, r: Rect, img: ImageData, mask?: ImageData, feather?: number, label?: string): HistoryId {
      const id = nextId++;
      const a = mask ? featherAlpha(Float32Array.from({ length: mask.width * mask.height }, (_, i) => mask.data[i * 4 + 3]! / 255), mask.width, mask.height, feather ?? 0) : null;
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w; x++) {
          const wt = a ? a[y * r.w + x]! : 1;
          const d = ((r.y + y) * eng.pixels.width + (r.x + x)) * 4;
          const s = (y * r.w + x) * 4;
          for (let c = 0; c < 4; c++) eng.pixels.data[d + c] = eng.pixels.data[d + c]! * (1 - wt) + img.data[s + c]! * wt;
        }
      }
      hist.push({ id, label: label ?? "", bounds: r, available: true });
      writes.push({ layerId, r, img: cloneImage(img), mask, feather, label, id });
      return id;
    },
    paint(r: Rect, color: [number, number, number, number]) {
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) eng.pixels.data.set(color, (y * eng.pixels.width + x) * 4);
      hist.push({ id: nextId++, label: "Brush", bounds: r, available: true });
    },
    history: () => hist.slice(),
    async snapshotAt(_id: HistoryId, r: Rect) {
      return cropImage(eng.pixels, r);
    },
    resizeCanvas(nw: number, nh: number) {
      const ow = eng.pixels.width;
      const oh = eng.pixels.height;
      const next = createImage(nw, nh);
      for (let y = 0; y < Math.min(oh, nh); y++) for (let x = 0; x < Math.min(ow, nw); x++) next.data.set(eng.pixels.data.subarray((y * ow + x) * 4, (y * ow + x) * 4 + 4), (y * nw + x) * 4);
      eng.pixels = next;
      doc.width = nw;
      doc.height = nh;
      return nextId++;
    },
    addLayer: () => "L2",
    setActive: () => undefined,
    resample: () => nextId++,
  };
  return eng as unknown as FakeEngine;
}

/** Codec that keeps images in memory behind opaque strings. */
export function createFakeCodec(): ImageCodec & { store: Map<string, ImageData> } {
  const store = new Map<string, ImageData>();
  let n = 0;
  return {
    store,
    async encode(img) {
      const k = `fake:${++n}:${img.width}x${img.height}`;
      store.set(k, cloneImage(img));
      return k;
    },
    async decode(url) {
      const img = store.get(url);
      if (!img) throw new Error(`unknown image ${url}`);
      return cloneImage(img);
    },
    async thumb(img) {
      return `thumb:${img.width}x${img.height}:${img.data[0]}`;
    },
  };
}

export type Responder = (req: PaintAIRequest, source: ImageData, mask: ImageData | null) => ImageData[];

/** Result 0 = final (value 200), result k = pass k (value 40·k), all the size of the request's source. */
export const solidResponder: Responder = (req, source) => {
  const make = (v: number) => {
    const img = createImage(source.width, source.height);
    for (let i = 0; i < source.width * source.height; i++) img.data.set([v, v, v, 255], i * 4);
    return img;
  };
  const out = [make(200)];
  for (let k = 1; k <= (req.passes || 0); k++) out.push(make(40 * k));
  return out;
};

export interface FakeAI {
  deps: AIDeps;
  codec: ReturnType<typeof createFakeCodec>;
  requests: PaintAIRequest[];
  cancelled: string[];
  jobIds: string[];
  /** "auto" finishes each job on the next macrotask; "manual" waits for finish/fail. */
  mode: "auto" | "manual";
  respond: Responder;
  failNext: boolean;
  finish(jobId: string): void;
  fail(jobId: string, error?: string): void;
  progress(jobId: string, p: number): void;
}

export function createFakeAI(): FakeAI {
  const codec = createFakeCodec();
  const jobs = new Map<string, JobLike>();
  const results = new Map<string, ImageData[]>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((cb) => cb());
  let n = 0;
  const ai: FakeAI = {
    codec,
    requests: [],
    cancelled: [],
    jobIds: [],
    mode: "auto",
    respond: solidResponder,
    failNext: false,
    finish(id) {
      const j = jobs.get(id);
      if (!j || j.status === "cancelled") return;
      jobs.set(id, { ...j, status: "done", progress: 1 });
      notify();
    },
    fail(id, error = "boom") {
      jobs.set(id, { status: "failed", progress: 0, message: "", error });
      notify();
    },
    progress(id, p) {
      const j = jobs.get(id);
      if (j) jobs.set(id, { ...j, progress: p });
      notify();
    },
    deps: {
      codec,
      async submit(_pid, req) {
        const id = `job${++n}`;
        ai.requests.push(req);
        ai.jobIds.push(id);
        jobs.set(id, { status: "running", progress: 0, message: "", error: "" });
        const src = await codec.decode(req.source);
        const mask = req.mask ? await codec.decode(req.mask) : null;
        results.set(id, ai.respond(req, src, mask));
        if (ai.mode === "auto") {
          setTimeout(() => (ai.failNext ? ((ai.failNext = false), ai.fail(id)) : ai.finish(id)), 0);
        }
        return { id };
      },
      async result(id, index) {
        const r = results.get(id)?.[index];
        if (!r) throw new Error(`no result ${index} for ${id}`);
        return codec.encode(r);
      },
      async cancelJob(id) {
        ai.cancelled.push(id);
        jobs.set(id, { status: "cancelled", progress: 0, message: "", error: "" });
        notify();
      },
      job: (id) => jobs.get(id),
      subscribeJobs(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
  };
  return ai;
}
