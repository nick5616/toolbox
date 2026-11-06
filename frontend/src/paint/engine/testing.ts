// Helpers for tests and PaintLab: a CPU-backed engine, a raw-bytes "PNG" codec,
// an in-memory TileSource and a complete default brush preset.

import type { BrushPreset } from "../brushes/schema";
import type { PngCodec, RawImage } from "./codec";
import { createCpuBackend } from "./cpuBackend";
import { createPaintEngine, type EngineOptions } from "./engine";
import type { InputPoint, PaintDoc, PaintEngine, RGBA, TileSource } from "./types";
import type { PaintEngineExt } from "./engine";

/** "PNG" = 8-byte header (w, h as u32) + raw RGBA. Round-trips exactly. */
export const rawCodec: PngCodec = {
  async encode(img: RawImage) {
    const out = new Uint8Array(8 + img.data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, img.width);
    dv.setUint32(4, img.height);
    out.set(img.data, 8);
    return out;
  },
  async decode(bytes: Uint8Array) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = dv.getUint32(0);
    const height = dv.getUint32(4);
    return { width, height, data: new Uint8ClampedArray(bytes.subarray(8, 8 + width * height * 4)) };
  },
  fromBitmap(b) {
    return b as unknown as RawImage;
  },
  async toBitmap(img) {
    return img as unknown as ImageBitmap;
  },
};

export function testBrush(over: Partial<BrushPreset> = {}): BrushPreset {
  return {
    version: 1,
    id: "test",
    name: "Test",
    set: "test",
    size: 20,
    minSize: 1,
    opacity: 1,
    flow: 1,
    spacing: 0.1,
    scatter: 0,
    count: 1,
    taper: { start: 0, end: 0, byPressure: false },
    tip: { shape: "round", hardness: 1, roundness: 1, angle: 0, angleMode: "fixed", rotationJitter: 0, invert: false },
    dual: null,
    grain: { texture: "", mode: "moving", scale: 1, depth: 0, contrast: 1 },
    dynamics: [],
    color: { hueJitter: 0, satJitter: 0, briJitter: 0, perStroke: false, secondaryMix: 0 },
    wet: { mix: 0, dilution: 0, charge: 1, pull: 0, grade: 0, edges: 0, bleed: 0 },
    rendering: "light-glaze",
    impasto: 0,
    blend: "normal",
    smoothing: { streamline: 0, stabilisation: 0, motionFilter: 0 },
    antialias: true,
    credit: "",
    license: "",
    fidelity: [],
    ...over,
  };
}

export const RED: RGBA = { r: 1, g: 0, b: 0, a: 1 };
export const BLUE: RGBA = { r: 0, g: 0, b: 1, a: 1 };

export function pt(x: number, y: number, t = 0, pressure = 1): InputPoint {
  return { x, y, pressure, tiltX: 0, tiltY: 0, twist: 0, t, pointer: "pen" };
}

/** A straight line of points every `step` px. */
export function line(x0: number, y0: number, x1: number, y1: number, step = 4): InputPoint[] {
  const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / step));
  const out: InputPoint[] = [];
  for (let i = 0; i <= n; i++) out.push(pt(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, i * 8));
  return out;
}

export function blankDoc(w: number, h: number, background = "transparent", layers = 1): PaintDoc {
  return {
    version: 1,
    width: w,
    height: h,
    background,
    layers: Array.from({ length: layers }, (_, i) => ({
      id: `l${i + 1}`,
      name: `Layer ${i + 1}`,
      hidden: false,
      locked: false,
      alphaLock: false,
      clip: false,
      reference: false,
      opacity: 1,
      blend: "normal",
      tiles: [],
      rev: 0,
    })),
    active: `l${layers}`,
    palette: [],
    guides: "",
    tileSize: 512,
    source: "",
  };
}

export const noTiles: TileSource = { load: async () => new Map() };

export async function testEngine(w = 128, h = 128, over: EngineOptions = {}, background = "transparent", layers = 1): Promise<PaintEngine & PaintEngineExt> {
  const e = createPaintEngine({ backend: createCpuBackend(), codec: rawCodec, ...over });
  await e.load(blankDoc(w, h, background, layers), noTiles);
  return e;
}

/** Stroke a polyline with the engine and finish it. */
export function strokeLine(e: PaintEngine, tool: Parameters<PaintEngine["beginStroke"]>[0], points: InputPoint[]) {
  e.beginStroke(tool, points[0] as InputPoint);
  e.extendStroke(points.slice(1), []);
  return e.endStroke();
}

/** Straight RGBA of one pixel of the active layer. */
export async function px(e: PaintEngine, x: number, y: number, src: "layer" | "merged" = "layer"): Promise<[number, number, number, number]> {
  const d = (await e.readRegion({ x, y, w: 1, h: 1 }, src)).data;
  return [d[0] as number, d[1] as number, d[2] as number, d[3] as number];
}
