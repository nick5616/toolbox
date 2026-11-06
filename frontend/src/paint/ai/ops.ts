// What each perception tool does with the queue. P5's tool handlers call these
// when a stroke ends (fill tools, enhance), on a click (subject, object) or from
// a dialog (extend, upscale). Everything here goes through the queue, so the
// engine runs one call at a time and the strip/pending states stay in sync.

import { PaintAIOp, PaintService, type PaintAIRequest } from "@/lib/api";
import type { PaintEngine, Point, Rect, SelectMode, StrokeResult } from "../engine/types";
import { planTiles, TILE_OVERLAP } from "./crops";
import { anchorFor, buildFill, extendBands, type Margins } from "./masks";
import { alphaBounds, createImage, cropImage, pasteImage, resizeBilinear } from "./pixels";
import type { PerceptionQueueImpl, SubmitRequest } from "./queue";
import type { GenerationGroup } from "./types";
import type { LabParams } from "../lab/types";

export const ENHANCE_PRESET = "photo"; // Real-ESRGAN x4plus, never the anime model
export const OBJECT_DEBOUNCE_MS = 120;
export const OBJECT_MAX_SIDE = 1536;

function emptyReq(op: PaintAIOp, source: ImageData): SubmitRequest {
  return { op, source, model: "", points: null, passes: 0, ghost: 0, drift: 0, driftDir: "", offset: [0, 0], seed: 0, scale: 0 };
}

function sampleOf(p: LabParams): "layer" | "merged" {
  return p["sampleAll"] === true ? "merged" : "layer";
}

/** Fill eraser, Dissolve, Melt, Echo fill, Edge erode: run when the stroke ends. */
export async function runFillTool(
  queue: PerceptionQueueImpl,
  engine: PaintEngine,
  toolId: string,
  params: LabParams,
  stroke: StrokeResult,
  seed: number,
): Promise<GenerationGroup | null> {
  if (!stroke.mask || stroke.history === null) return null;
  const bounds = stroke.bounds;
  const { mask, fields } = buildFill(toolId, stroke.mask, params);
  const sample = sampleOf(params);
  const source = await engine.readRegion(bounds, sample);
  const req: SubmitRequest = {
    ...emptyReq(PaintAIOp.OpFill, source),
    mask,
    model: fields.model,
    passes: fields.passes,
    ghost: fields.ghost,
    drift: fields.drift,
    driftDir: fields.driftDir,
    offset: [fields.offset[0], fields.offset[1]],
    seed,
  };
  return queue.submit(toolId, bounds, req, { sample, label: toolLabel(toolId) });
}

function toolLabel(id: string): string {
  return id.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Enhance brush: enhance the crop, resample it back, composite under the stroke. */
export async function runEnhanceBrush(queue: PerceptionQueueImpl, engine: PaintEngine, params: LabParams, stroke: StrokeResult, seed: number): Promise<GenerationGroup | null> {
  if (!stroke.mask || stroke.history === null) return null;
  const bounds = stroke.bounds;
  const sample = sampleOf(params);
  const source = await engine.readRegion(bounds, sample);
  const req: SubmitRequest = { ...emptyReq(PaintAIOp.OpEnhance, source), mask: stroke.mask, model: ENHANCE_PRESET, scale: Number(params["scale"] ?? 2) === 4 ? 4 : 2, seed };
  return queue.submit("enhance-brush", bounds, req, { sample, label: "Enhance brush" });
}

/** Alpha of a mask result: the alpha when it has any transparency, else the gray value. */
export function maskFromResult(img: ImageData): ImageData {
  let opaque = true;
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const out = createImage(img.width, img.height);
  for (let i = 0; i < img.width * img.height; i++) {
    const o = i * 4;
    out.data[o] = out.data[o + 1] = out.data[o + 2] = 255;
    out.data[o + 3] = opaque ? img.data[o]! : img.data[o + 3]!;
  }
  return out;
}

async function cutoutLayer(queue: PerceptionQueueImpl, engine: PaintEngine, params: LabParams, layerId?: string): Promise<{ cut: ImageData; full: Rect }> {
  const full: Rect = { x: 0, y: 0, w: engine.doc.width, h: engine.doc.height };
  void layerId;
  const source = await engine.readRegion(full, sampleOf(params));
  const model = typeof params["quality"] === "string" ? params["quality"] : "balanced";
  const cut = await queue.call("select-subject", full, { ...emptyReq(PaintAIOp.OpCutout, source), model });
  return { cut, full };
}

/** Select subject: background removal → selection. */
export async function selectSubject(queue: PerceptionQueueImpl, engine: PaintEngine, params: LabParams, mode: SelectMode = "replace"): Promise<void> {
  const { cut } = await cutoutLayer(queue, engine, params);
  engine.selection.fromMask(cut, { x: 0, y: 0 }, mode);
}

/** Cut subject to new layer: the cut-out lands on a new layer above the active one. */
export async function cutSubjectToNewLayer(queue: PerceptionQueueImpl, engine: PaintEngine, params: LabParams): Promise<string> {
  const { cut, full } = await cutoutLayer(queue, engine, params);
  const id = engine.addLayer({ name: "Subject" });
  engine.writeRegion(id, full, cut, undefined, 0, "Cut subject to new layer");
  return id;
}

export interface StampTip {
  /** The RGBA cut-out, trimmed to its bounding box. */
  image: ImageData;
  /** Where the trimmed box sat on the layer (canvas px). */
  origin: Rect;
}

/**
 * Subject stamp tips, one per layer, cut out once and cached. P1's brush
 * engine consumes them through `tip(layerId)` (synchronous, from the cache; null
 * until `cut` resolved). The cache entry is keyed by layer and by the last
 * history step at cut time, so changing the layer cuts again on the next click.
 */
export interface StampTips {
  cut(layerId: string, params: LabParams): Promise<StampTip>;
  tip(layerId: string): StampTip | null;
  clear(): void;
}

export function createStampTips(queue: PerceptionQueueImpl, engine: PaintEngine): StampTips {
  const cache = new Map<string, { key: string; tip: StampTip }>();
  const keyOf = () => String(engine.history().at(-1)?.id ?? 0);
  const inflight = new Map<string, Promise<StampTip>>();
  return {
    tip: (layerId) => cache.get(layerId)?.tip ?? null,
    clear: () => cache.clear(),
    cut: (layerId, params) => {
      const key = keyOf();
      const hit = cache.get(layerId);
      if (hit && hit.key === key) return Promise.resolve(hit.tip);
      const running = inflight.get(layerId + key);
      if (running) return running;
      const full: Rect = { x: 0, y: 0, w: engine.doc.width, h: engine.doc.height };
      const p = (async () => {
        const source = await engine.readRegion(full, "layer");
        const model = typeof params["quality"] === "string" ? params["quality"] : "balanced";
        const cut = await queue.call("subject-stamp", full, { ...emptyReq(PaintAIOp.OpCutout, source), model });
        const box = alphaBounds(cut, 8);
        if (!box) throw new Error("No subject was found in that layer");
        const tip: StampTip = { image: cropImage(cut, box), origin: box };
        cache.set(layerId, { key, tip });
        return tip;
      })().finally(() => inflight.delete(layerId + key));
      inflight.set(layerId + key, p);
      return p;
    },
  };
}

export interface ObjectPoint extends Point {
  positive: boolean;
}

export interface ObjectSelector {
  /** Click (positive) or Alt-click (negative) in canvas px. Schedules a preview. */
  add(p: ObjectPoint): void;
  undoPoint(): void;
  points(): ObjectPoint[];
  /** Latest preview mask over the canvas (white, alpha = mask) or null. */
  preview(): ImageData | null;
  /** Enter: make the preview the selection. Resolves when the last pending preview landed. */
  commit(mode?: SelectMode): Promise<boolean>;
  cancel(): void;
  on(cb: () => void): () => void;
}

/**
 * Select object: points → live mask preview (debounced 120 ms, only the latest
 * result is kept). The source is the whole canvas, downscaled to ≤ 1536 px on
 * its long side; points are scaled with it and the mask is scaled back up.
 */
export function createObjectSelector(queue: PerceptionQueueImpl, engine: PaintEngine, params: LabParams, schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms), unschedule: (h: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>)): ObjectSelector {
  const pts: ObjectPoint[] = [];
  const listeners = new Set<() => void>();
  let timer: unknown = null;
  let seq = 0;
  let latest: ImageData | null = null;
  let settled: Promise<void> = Promise.resolve();
  let sourceCache: ImageData | null = null;

  const emit = () => listeners.forEach((cb) => cb());

  async function run(my: number): Promise<void> {
    const full: Rect = { x: 0, y: 0, w: engine.doc.width, h: engine.doc.height };
    const k = Math.min(1, OBJECT_MAX_SIDE / Math.max(full.w, full.h));
    const w = Math.max(1, Math.round(full.w * k));
    const h = Math.max(1, Math.round(full.h * k));
    sourceCache ??= resizeBilinear(await engine.readRegion(full, sampleOf(params)), w, h);
    const req: SubmitRequest = {
      ...emptyReq(PaintAIOp.OpSegment, sourceCache),
      points: pts.map((p) => ({ x: Math.round(p.x * k), y: Math.round(p.y * k), positive: p.positive })),
    };
    const res = await queue.call("select-object", full, req);
    if (my !== seq) return; // a newer point superseded this one
    latest = resizeBilinear(maskFromResult(res), full.w, full.h);
    emit();
  }

  function schedulePreview(): void {
    if (timer !== null) unschedule(timer);
    timer = schedule(() => {
      timer = null;
      if (pts.length === 0) return;
      const my = ++seq;
      settled = run(my).catch(() => undefined);
    }, OBJECT_DEBOUNCE_MS);
  }

  return {
    add(p) {
      if (pts.length >= 64) return;
      pts.push(p);
      seq++;
      schedulePreview();
    },
    undoPoint() {
      pts.pop();
      seq++;
      if (pts.length === 0) {
        latest = null;
        emit();
      } else schedulePreview();
    },
    points: () => pts.slice(),
    preview: () => latest,
    async commit(mode = "replace") {
      if (timer !== null) {
        unschedule(timer);
        timer = null;
        if (pts.length > 0) {
          const my = ++seq;
          settled = run(my).catch(() => undefined);
        }
      }
      await settled;
      if (!latest) return false;
      engine.selection.fromMask(latest, { x: 0, y: 0 }, mode);
      return true;
    },
    cancel() {
      if (timer !== null) unschedule(timer);
      timer = null;
      seq++;
      pts.length = 0;
      latest = null;
      sourceCache = null;
      emit();
    },
    on: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** Extend canvas with fill: resize first, then fill the new margins in 512 px bands, one after another. */
export async function extendCanvasWithFill(
  queue: PerceptionQueueImpl,
  engine: PaintEngine,
  margins: Margins,
  params: LabParams,
  seed: number,
): Promise<GenerationGroup[]> {
  const oldW = engine.doc.width;
  const oldH = engine.doc.height;
  const newW = oldW + margins.left + margins.right;
  const newH = oldH + margins.top + margins.bottom;
  if (newW === oldW && newH === oldH) return [];
  engine.resizeCanvas(newW, newH, anchorFor(margins));
  const model = params["quality"] === "fast" ? "fast" : "best";
  const groups: GenerationGroup[] = [];
  for (const band of extendBands(oldW, oldH, margins)) {
    const source = await engine.readRegion(band.bounds, "layer");
    const req: SubmitRequest = { ...emptyReq(PaintAIOp.OpFill, source), mask: band.mask, model, passes: 1, seed };
    groups.push(await queue.submit("extend-canvas", band.bounds, req, { sample: "layer", label: "Extend canvas" }));
  }
  return groups;
}

/** Enhance a whole image in 512 px tiles through the queue; returns it at scale×. */
export async function enhanceImage(queue: PerceptionQueueImpl, img: ImageData, scale: 2 | 4, tile = 512): Promise<ImageData> {
  const out = createImage(img.width * scale, img.height * scale);
  const whole: Rect = { x: 0, y: 0, w: img.width, h: img.height };
  const tiles = planTiles(whole, tile, TILE_OVERLAP / 2);
  for (const t of tiles) {
    const sub = cropImage(img, t);
    if (!hasAlpha(sub)) continue;
    const res = await queue.call("upscale-canvas", t, { ...emptyReq(PaintAIOp.OpEnhance, sub), model: ENHANCE_PRESET, scale });
    const fit = resizeBilinear(res, t.w * scale, t.h * scale);
    // Overlaps are simply overwritten by the later tile; the 16 px overlap hides seams.
    pasteImage(out, fit, t.x * scale, t.y * scale);
  }
  return out;
}

function hasAlpha(img: ImageData): boolean {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! > 0) return true;
  return false;
}

export interface UpscaleResult {
  /** The new project's ID (target "new"), "" when done in place. */
  projectId: string;
}

/**
 * Upscale canvas. "new": the merged picture is enhanced and saved as a new
 * project (PaintService.Create + SaveTiles). "inplace": the canvas is resampled
 * and every visible layer is replaced by its enhanced version (one undo step each).
 */
export async function upscaleCanvas(
  queue: PerceptionQueueImpl,
  engine: PaintEngine,
  params: LabParams,
  opts: { name: string; encodeTile: (img: ImageData) => Promise<string> },
): Promise<UpscaleResult> {
  const scale: 2 | 4 = Number(params["scale"] ?? 2) === 4 ? 4 : 2;
  const w = engine.doc.width;
  const h = engine.doc.height;
  const full: Rect = { x: 0, y: 0, w, h };
  if (params["target"] === "inplace") {
    const layers = (engine.doc.layers ?? []).filter((l) => !l.hidden);
    const results: Array<{ id: string; img: ImageData }> = [];
    const active = engine.doc.active;
    for (const l of layers) {
      engine.setActive(l.id);
      const img = await engine.readRegion(full, "layer");
      results.push({ id: l.id, img: await enhanceImage(queue, img, scale) });
    }
    engine.setActive(active);
    engine.resample(w * scale, h * scale);
    const big: Rect = { x: 0, y: 0, w: w * scale, h: h * scale };
    for (const r of results) engine.writeRegion(r.id, big, r.img, undefined, 0, "Upscale canvas");
    return { projectId: "" };
  }
  const merged = await engine.readRegion(full, "merged");
  const up = await enhanceImage(queue, merged, scale);
  const id = await PaintService.Create(opts.name, up.width, up.height, "transparent");
  const doc = await PaintService.Load(id);
  const layerId = doc.active || (doc.layers ?? [])[0]?.id || "";
  const tiles: Record<string, string> = {};
  for (let ty = 0; ty * 512 < up.height; ty++) {
    for (let tx = 0; tx * 512 < up.width; tx++) {
      const t = cropImage(up, { x: tx * 512, y: ty * 512, w: Math.min(512, up.width - tx * 512), h: Math.min(512, up.height - ty * 512) });
      if (hasAlpha(t)) tiles[`${tx}_${ty}`] = await opts.encodeTile(t);
    }
  }
  await PaintService.SaveTiles(id, layerId, tiles, []);
  return { projectId: id };
}

export type { PaintAIRequest };
