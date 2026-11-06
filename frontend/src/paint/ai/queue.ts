// The perception queue (Phase 19, SPEC §1.4.2 "Async behaviour" and §2.5).
//
// One engine call at a time. A request is cropped (crops.ts), sent through
// PaintService.AI as a quiet `paint-ai` job, followed in the job store, and
// its result composited under the mask with a 4 px feather as ONE undo step
// (engine.writeRegion). Every landed result is a GenerationGroup the strip can
// swap through.
//
// Painting over a pending region: the result still lands. The target layer's
// pixels in the mask bounds are re-read when the result arrives and compared
// with what they were when the request started; every pixel the user changed
// meanwhile keeps its current colour on top of the result (exact for opaque
// painting; translucent strokes keep their final composited colour instead of
// being re-composited over the new fill). The engine contract has no "replay
// strokes" call, and snapshotAt would only return the same two images.
// Replay only runs when the target layer is the active layer (readRegion's
// "layer" source); otherwise the result is written as is.

import type { PaintAIRequest } from "@/lib/api";
import type { HistoryId, PaintEngine, Rect } from "../engine/types";
import type { Generation, GenerationGroup, PendingRegion, PerceptionQueue } from "./types";
import type { AIDeps } from "./deps";
import { defaultAIDeps } from "./service";
import { FEATHER_PX, limitsFor, planCrop, tileWeights, type AIOpName, type AIQuality } from "./crops";
import {
  alphaOf,
  cloneImage,
  createImage,
  cropImage,
  embedMask,
  imagesEqual,
  pasteImage,
  resizeBilinear,
} from "./pixels";
import { solidMask } from "./masks";

export const MAX_GROUPS = 8;
const THUMB = 96;

export type SubmitRequest = Omit<PaintAIRequest, "source" | "mask"> & { source: ImageData; mask?: ImageData };

export interface SubmitOptions {
  /** Layer the result is written to (default: the active layer). */
  layerId?: string;
  /** Where context pixels come from (default "layer"; "merged" = sample all). */
  sample?: "layer" | "merged";
  /** History label of the applied step. */
  label?: string;
}

export interface PerceptionQueueImpl extends PerceptionQueue {
  submit(toolId: string, bounds: Rect, req: SubmitRequest, opts?: SubmitOptions): Promise<GenerationGroup>;
  /** Runs one engine call in the queue without compositing (cutout, segment): resolves with result 0. */
  call(toolId: string, bounds: Rect, req: SubmitRequest): Promise<ImageData>;
  /** Removes a failed or cancelled pending entry. */
  dismiss(id: string): void;
}

export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

interface Task {
  id: string;
  toolId: string;
  bounds: Rect;
  cancelled: boolean;
  jobId: string;
  failMessage: string;
  run(task: Task): Promise<void>;
  reject(e: unknown): void;
}

interface Processed {
  plan: ReturnType<typeof planCrop>;
  works: ImageData[]; // 0 = final, 1..n = passes (crop sized)
  layerBefore: ImageData; // target layer at bounds when the request started
}

interface GroupRecord {
  layerId: string;
  toolId: string;
  req: SubmitRequest;
  opts: SubmitOptions;
  mask: ImageData; // bounds sized
  images: ImageData[]; // one per generation, bounds sized
  /** Crop-sized context as it was when the request started (re-rolls reuse it). */
  context: ImageData;
  rerolls: number;
}

function failText(op: string): string {
  switch (op) {
    case "fill":
      return "That fill failed — try again";
    case "enhance":
      return "That enhance failed — try again";
    case "cutout":
      return "That cut-out failed — try again";
    default:
      return "That selection failed — try again";
  }
}

function qualityOf(req: { op: string; model: string }): AIQuality {
  return req.op === "fill" && req.model === "fast" ? "fast" : "best";
}

/** Mask as the engine wants it: opaque grayscale, white = fill. */
export function maskToGray(mask: ImageData): ImageData {
  const out = createImage(mask.width, mask.height);
  for (let i = 0; i < mask.width * mask.height; i++) {
    const a = mask.data[i * 4 + 3]!;
    out.data[i * 4] = a;
    out.data[i * 4 + 1] = a;
    out.data[i * 4 + 2] = a;
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

export function createPerceptionQueue(engine: PaintEngine, projectId: () => string, deps: AIDeps = defaultAIDeps()): PerceptionQueueImpl {
  const pendingMap = new Map<string, PendingRegion>();
  const waiting: Task[] = [];
  let running: Task | null = null;
  let groupList: GenerationGroup[] = [];
  const records = new Map<string, GroupRecord>();
  const listeners = new Set<() => void>();
  let counter = 0;

  const emit = () => {
    for (const cb of [...listeners]) cb();
  };
  const patch = (id: string, p: Partial<PendingRegion>) => {
    const cur = pendingMap.get(id);
    if (!cur) return;
    pendingMap.set(id, { ...cur, ...p });
    emit();
  };

  function pump(): void {
    if (running) return;
    const next = waiting.shift();
    if (!next) return;
    running = next;
    patch(next.id, { state: "running", message: "Working" });
    next
      .run(next)
      .catch((e: unknown) => next.reject(e))
      .finally(() => {
        running = null;
        pump();
      });
  }

  function enqueue<T>(toolId: string, bounds: Rect, work: (task: Task) => Promise<T>): Promise<T> {
    const id = `q${++counter}`;
    return new Promise<T>((resolve, reject) => {
      const task: Task = {
        id,
        toolId,
        bounds,
        cancelled: false,
        jobId: "",
        failMessage: "That didn't work — try again",
        reject: (e) => {
          const cancelled = task.cancelled || e instanceof CancelledError;
          const cur = pendingMap.get(id);
          if (cur && cur.state !== "failed" && cur.state !== "cancelled") {
            patch(id, { state: cancelled ? "cancelled" : "failed", message: cancelled ? "Cancelled" : task.failMessage });
          }
          reject(e);
        },
        run: async (t) => {
          resolve(await work(t));
          pendingMap.delete(id);
          emit();
        },
      };
      pendingMap.set(id, { id, jobId: "", toolId, bounds, state: "queued", progress: 0, message: "Waiting" });
      waiting.push(task);
      emit();
      pump();
    });
  }

  function setFail(task: Task, op: string): void {
    task.failMessage = failText(op);
  }

  async function waitForJob(task: Task, jobId: string, onProgress: (p: number) => void): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let off: (() => void) | null = null;
      const check = (): boolean => {
        const j = deps.job(jobId);
        if (!j) return false;
        if (j.status === "running") onProgress(j.progress);
        if (j.status === "done") {
          resolve();
          return true;
        }
        if (j.status === "cancelled") {
          task.cancelled = true;
          reject(new CancelledError());
          return true;
        }
        if (j.status === "failed") {
          reject(new Error(j.error || "failed"));
          return true;
        }
        return false;
      };
      if (check()) return;
      off = deps.subscribeJobs(() => {
        if (check()) off?.();
      });
    });
  }

  /** One engine call: submit, follow, load results 0..passes. */
  async function callEngine(task: Task, req: PaintAIRequest, passes: number, onProgress: (p: number) => void): Promise<ImageData[]> {
    const job = await deps.submit(projectId(), req);
    task.jobId = job.id;
    patch(task.id, { jobId: job.id });
    if (task.cancelled) {
      void deps.cancelJob(job.id);
    }
    await waitForJob(task, job.id, onProgress);
    if (task.cancelled) throw new CancelledError();
    const out: ImageData[] = [];
    for (let i = 0; i <= passes; i++) out.push(await deps.codec.decode(await deps.result(job.id, i)));
    return out;
  }

  async function encodeRequest(src: ImageData, mask: ImageData | undefined, w: number, h: number, req: SubmitRequest): Promise<PaintAIRequest> {
    const s = src.width === w && src.height === h ? src : resizeBilinear(src, w, h);
    const sourceUrl = await deps.codec.encode(s);
    let maskUrl = "";
    if (mask) {
      const m = mask.width === w && mask.height === h ? mask : resizeBilinear(mask, w, h);
      maskUrl = await deps.codec.encode(maskToGray(m));
    }
    const { source: _s, mask: _m, ...rest } = req;
    void _s;
    void _m;
    return { ...rest, source: sourceUrl, mask: maskUrl };
  }

  /** Runs the (possibly tiled) request and returns the blended pass buffers. */
  async function process(task: Task, req: SubmitRequest, mask: ImageData, context: ImageData, plan: Processed["plan"], layerBefore: ImageData): Promise<Processed> {
    const passes = req.op === "fill" ? Math.max(1, req.passes) : 0;
    const keep = passes > 1 ? passes : 0; // intermediate buffers only when they differ from the final
    const works: ImageData[] = [];
    for (let k = 0; k <= keep; k++) works.push(cloneImage(context));
    const rect = plan.rect;
    const wsum = new Float32Array(rect.w * rect.h);
    const accum = works.map(() => new Float32Array(rect.w * rect.h * 4));
    const maskCrop = embedMask(mask, rect.w, rect.h, task.bounds.x - rect.x, task.bounds.y - rect.y);
    const nTiles = plan.tiles.length;
    for (let ti = 0; ti < nTiles; ti++) {
      if (task.cancelled) throw new CancelledError();
      const t = plan.tiles[ti]!;
      const rel: Rect = { x: t.rect.x - rect.x, y: t.rect.y - rect.y, w: t.rect.w, h: t.rect.h };
      const tileMask = cropImage(maskCrop, rel);
      if (req.op === "fill" || req.op === "enhance") {
        let any = false;
        for (let i = 3; i < tileMask.data.length; i += 4) {
          if (tileMask.data[i]! > 0) {
            any = true;
            break;
          }
        }
        if (!any) continue;
      }
      const ratio = t.sendW / t.rect.w;
      const tileReq: SubmitRequest = { ...req, offset: [Math.round((req.offset[0] ?? 0) * ratio), Math.round((req.offset[1] ?? 0) * ratio)] };
      const src = cropImage(works[0]!, rel);
      const encoded = await encodeRequest(src, req.op === "fill" ? tileMask : undefined, t.sendW, t.sendH, tileReq);
      const results = await callEngine(task, encoded, passes, (p) => patch(task.id, { progress: (ti + p) / nTiles }));
      const weights = tileWeights(t.rect, rect);
      const ma = alphaOf(tileMask);
      const resized: ImageData[] = [];
      for (let k = 0; k <= keep; k++) resized.push(resizeBilinear(results[Math.min(k, results.length - 1)]!, t.rect.w, t.rect.h));
      // Overlapping tiles are averaged by their edge ramps; the mask then decides how much of
      // that average replaces the original. Re-finalised per tile so the next tile's context
      // already contains this tile's fill.
      for (let y = 0; y < t.rect.h; y++) {
        for (let x = 0; x < t.rect.w; x++) {
          const ti2 = y * t.rect.w + x;
          const tw = weights[ti2]!;
          if (tw <= 0) continue;
          const ci = (rel.y + y) * rect.w + rel.x + x;
          wsum[ci] = wsum[ci]! + tw;
          const m = ma[ti2]!;
          for (let k = 0; k <= keep; k++) {
            const acc = accum[k]!;
            const dst = works[k]!;
            const res = resized[k]!;
            for (let c = 0; c < 4; c++) {
              acc[ci * 4 + c] = acc[ci * 4 + c]! + tw * res.data[ti2 * 4 + c]!;
              dst.data[ci * 4 + c] = context.data[ci * 4 + c]! * (1 - m) + (acc[ci * 4 + c]! / wsum[ci]!) * m;
            }
          }
        }
      }
    }
    return { plan, works, layerBefore };
  }

  function boundsRel(b: Rect, rect: Rect): Rect {
    return { x: b.x - rect.x, y: b.y - rect.y, w: b.w, h: b.h };
  }

  /** The result with the user's later edits kept (see the header comment). */
  async function withLaterEdits(final: ImageData, layerBefore: ImageData, layerId: string, bounds: Rect): Promise<ImageData> {
    if (engine.doc.active !== layerId) return final;
    const now = await engine.readRegion(bounds, "layer");
    if (imagesEqual(now, layerBefore)) return final;
    const out = cloneImage(final);
    for (let i = 0; i < layerBefore.width * layerBefore.height; i++) {
      const o = i * 4;
      if (now.data[o] !== layerBefore.data[o] || now.data[o + 1] !== layerBefore.data[o + 1] || now.data[o + 2] !== layerBefore.data[o + 2] || now.data[o + 3] !== layerBefore.data[o + 3]) {
        out.data[o] = now.data[o]!;
        out.data[o + 1] = now.data[o + 1]!;
        out.data[o + 2] = now.data[o + 2]!;
        out.data[o + 3] = now.data[o + 3]!;
      }
    }
    return out;
  }

  async function gen(id: string, label: string, bounds: Rect, img: ImageData, history: HistoryId | null): Promise<Generation> {
    return { id, label, bounds, thumb: await deps.codec.thumb(img, THUMB), history };
  }

  function touchGroup(g: GenerationGroup): void {
    groupList = [g, ...groupList.filter((x) => x.id !== g.id)].slice(0, MAX_GROUPS);
    for (const id of [...records.keys()]) if (!groupList.some((x) => x.id === id)) records.delete(id);
    emit();
  }

  function submit(toolId: string, bounds: Rect, req: SubmitRequest, opts: SubmitOptions = {}): Promise<GenerationGroup> {
    return enqueue(toolId, bounds, async (task) => {
      setFail(task, req.op);
      const layerId = opts.layerId ?? engine.doc.active;
      const sample = opts.sample ?? "layer";
      const plan = planCrop(bounds, engine.doc.width, engine.doc.height, req.op as AIOpName, qualityOf(req));
      const context = await engine.readRegion(plan.rect, sample);
      const rel = boundsRel(bounds, plan.rect);
      const layerBefore = sample === "layer" ? cropImage(context, rel) : await engine.readRegion(bounds, "layer");
      pasteImage(context, req.source, rel.x, rel.y);
      const mask = req.mask ?? solidMask(bounds.w, bounds.h);
      const done = await process(task, req, mask, context, plan, layerBefore);
      return land(task, layerId, req, opts, mask, context, done);
    });
  }

  async function land(task: Task, layerId: string, req: SubmitRequest, opts: SubmitOptions, mask: ImageData, context: ImageData, done: Processed): Promise<GenerationGroup> {
    const bounds = task.bounds;
    const rel = boundsRel(bounds, done.plan.rect);
    const images = done.works.map((w) => cropImage(w, rel));
    const final = images[0]!;
    const toWrite = await withLaterEdits(final, done.layerBefore, layerId, bounds);
    const label = opts.label ?? "Perception fill";
    const hist = engine.writeRegion(layerId, bounds, toWrite, mask, FEATHER_PX, label);

    const gid = `g${++counter}`;
    const gens: Generation[] = [await gen(`${gid}-orig`, "Original", bounds, done.layerBefore, null)];
    const all: ImageData[] = [done.layerBefore];
    for (let k = 1; k < images.length; k++) {
      gens.push(await gen(`${gid}-p${k}`, `Pass ${k}`, bounds, images[k]!, null));
      all.push(images[k]!);
    }
    gens.push(await gen(`${gid}-final`, "Final", bounds, toWrite, hist));
    all.push(final);
    const group: GenerationGroup = { id: gid, toolId: task.toolId, bounds, seed: req.seed, generations: gens, current: gens.length - 1 };
    records.set(gid, { layerId, toolId: task.toolId, req, opts, mask, images: all, context, rerolls: 0 });
    touchGroup(group);
    return group;
  }

  function choose(groupId: string, index: number): void {
    const g = groupList.find((x) => x.id === groupId);
    const rec = records.get(groupId);
    if (!g || !rec) return;
    const img = rec.images[index];
    const target = g.generations[index];
    if (!img || !target) return;
    const hist = engine.writeRegion(rec.layerId, g.bounds, img, rec.mask, FEATHER_PX, `${rec.opts.label ?? "Perception fill"}: ${target.label}`);
    const generations = g.generations.map((x, i) => (i === index ? { ...x, history: hist } : x));
    touchGroup({ ...g, generations, current: index });
  }

  function reroll(groupId: string): Promise<GenerationGroup> {
    const g = groupList.find((x) => x.id === groupId);
    const rec = records.get(groupId);
    if (!g || !rec) return Promise.reject(new Error("That generation is no longer available"));
    const n = rec.rerolls + 1;
    const seed = rec.req.seed + n;
    const req: SubmitRequest = { ...rec.req, seed };
    return enqueue(rec.toolId, g.bounds, async (task) => {
      setFail(task, req.op);
      const plan = planCrop(g.bounds, engine.doc.width, engine.doc.height, req.op as AIOpName, qualityOf(req));
      const layerBefore = rec.images[0]!;
      const done = await process(task, req, rec.mask, rec.context, plan, layerBefore);
      const rel = boundsRel(g.bounds, plan.rect);
      const final = cropImage(done.works[0]!, rel);
      const fresh = groupList.find((x) => x.id === groupId);
      const rec2 = records.get(groupId);
      if (!fresh || !rec2) throw new Error("That generation is no longer available");
      const toWrite = await withLaterEdits(final, layerBefore, rec.layerId, g.bounds);
      const hist = engine.writeRegion(rec.layerId, g.bounds, toWrite, rec.mask, FEATHER_PX, `${rec.opts.label ?? "Perception fill"}: Re-roll ${n}`);
      rec2.rerolls = n;
      rec2.images.push(final);
      const next: GenerationGroup = {
        ...fresh,
        seed,
        generations: [...fresh.generations, await gen(`${groupId}-r${n}`, `Re-roll ${n}`, g.bounds, toWrite, hist)],
        current: fresh.generations.length,
      };
      touchGroup(next);
      return next;
    });
  }

  function call(toolId: string, bounds: Rect, req: SubmitRequest): Promise<ImageData> {
    return enqueue(toolId, bounds, async (task) => {
      setFail(task, req.op);
      const lim = limitsFor(req.op as AIOpName, "best");
      const big = Math.max(req.source.width, req.source.height);
      const k = lim.downscaleAbove !== null && big > lim.downscaleAbove ? lim.downscaleAbove / big : 1;
      const w = Math.max(1, Math.round(req.source.width * k));
      const h = Math.max(1, Math.round(req.source.height * k));
      const encoded = await encodeRequest(req.source, req.mask, w, h, req);
      const results = await callEngine(task, encoded, 0, (p) => patch(task.id, { progress: p }));
      const r = results[0]!;
      return req.op === "cutout" && (r.width !== req.source.width || r.height !== req.source.height) ? resizeBilinear(r, req.source.width, req.source.height) : r;
    });
  }

  function cancel(id: string): void {
    const cur = pendingMap.get(id);
    if (!cur) return;
    if (cur.state === "failed" || cur.state === "cancelled") {
      pendingMap.delete(id);
      emit();
      return;
    }
    const wi = waiting.findIndex((t) => t.id === id);
    if (wi >= 0) {
      const [t] = waiting.splice(wi, 1);
      t!.cancelled = true;
      t!.reject(new CancelledError());
      return;
    }
    if (running && running.id === id) {
      running.cancelled = true;
      patch(id, { message: "Cancelling" });
      if (running.jobId) void deps.cancelJob(running.jobId);
    }
  }

  return {
    submit,
    call,
    cancel,
    dismiss: (id) => {
      const cur = pendingMap.get(id);
      if (cur && (cur.state === "failed" || cur.state === "cancelled")) {
        pendingMap.delete(id);
        emit();
      }
    },
    pending: () => [...pendingMap.values()],
    groups: () => groupList.slice(),
    choose,
    reroll,
    on: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
