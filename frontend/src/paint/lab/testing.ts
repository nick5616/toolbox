// A minimal CPU LabContext for tests: a layer and a scratch target as plain
// ImageData, a seeded rng and recorders for dabs. Not used by the app.

import type { InputPoint, Rect } from "../engine/types";
import { makeImage } from "./common";
import type { DabStyle, LabContextExt } from "./ext";
import { flushTool } from "./ext";
import type { LabContext, LabParams, LabTool } from "./types";

export interface Harness {
  ctx: LabContext & LabContextExt;
  layer: ImageData;
  scratch: ImageData;
  /** Every dab batch, in order. */
  dabs: Array<{ points: InputPoint[]; style?: DabStyle }>;
  composites: number;
}

export interface HarnessOptions {
  w?: number;
  h?: number;
  seed?: number;
  params?: LabParams;
  /** Provide clearScratch (default true). */
  clearScratch?: boolean;
  /** Provide dabAs (default true). */
  dabAs?: boolean;
  brushSize?: number;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function seededRng(seed: number, key: string): () => number {
  let a = (hashString(key) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deterministic test picture: colour gradients with a few hard features. */
export function testLayer(w: number, h: number): ImageData {
  const img = makeImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const stripe = Math.floor(x / 7) % 2;
      img.data[i] = Math.round((x / w) * 255);
      img.data[i + 1] = Math.round((y / h) * 255);
      img.data[i + 2] = stripe ? 200 : 40 + ((x * 13 + y * 7) % 90);
      img.data[i + 3] = 255;
    }
  }
  return img;
}

function overPixel(dst: Uint8ClampedArray, k: number, r: number, g: number, b: number, a: number): void {
  const ao = (dst[k + 3] as number) / 255;
  const out = a + ao * (1 - a);
  if (out <= 0) return;
  for (let c = 0; c < 3; c++) {
    const src = c === 0 ? r : c === 1 ? g : b;
    dst[k + c] = (src * a + (dst[k + c] as number) * ao * (1 - a)) / out;
  }
  dst[k + 3] = out * 255;
}

export function createHarness(opts: HarnessOptions = {}): Harness {
  const w = opts.w ?? 96;
  const h = opts.h ?? 96;
  const seed = opts.seed ?? 1;
  const layer = testLayer(w, h);
  const scratch = makeImage(w, h);
  const hs: Harness = { ctx: null as unknown as Harness["ctx"], layer, scratch, dabs: [], composites: 0 };

  const stamp = (points: InputPoint[], color: [number, number, number], size: number, opacity: number) => {
    for (const p of points) {
      const r = Math.max(1, size * Math.max(0.2, p.pressure));
      for (let y = Math.floor(p.y - r); y <= Math.ceil(p.y + r); y++) {
        for (let x = Math.floor(p.x - r); x <= Math.ceil(p.x + r); x++) {
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const d = Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y);
          if (d > r) continue;
          overPixel(scratch.data, (y * w + x) * 4, color[0], color[1], color[2], opacity * (1 - d / r) * 0.9 + 0.1 * opacity);
        }
      }
    }
  };

  const ctx: LabContext & LabContextExt = {
    rng: (key) => seededRng(seed, key),
    snapshot: (r: Rect) => {
      const out = makeImage(r.w, r.h);
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w; x++) {
          const gx = r.x + x;
          const gy = r.y + y;
          if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
          const s = (gy * w + gx) * 4;
          const o = (y * r.w + x) * 4;
          out.data[o] = layer.data[s] as number;
          out.data[o + 1] = layer.data[s + 1] as number;
          out.data[o + 2] = layer.data[s + 2] as number;
          out.data[o + 3] = layer.data[s + 3] as number;
        }
      }
      return Promise.resolve(out);
    },
    gl: null,
    dab: (points) => {
      hs.dabs.push({ points: points.map((p) => ({ ...p })) });
      stamp(points, [20, 20, 20], 2, 1);
    },
    composite: (img, r, mask) => {
      hs.composites++;
      const src = img as ImageData;
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w; x++) {
          const gx = r.x + x;
          const gy = r.y + y;
          if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
          const o = (y * r.w + x) * 4;
          const a = ((src.data[o + 3] as number) / 255) * (mask ? (mask.data[o + 3] as number) / 255 : 1);
          if (a <= 0) continue;
          overPixel(scratch.data, (gy * w + gx) * 4, src.data[o] as number, src.data[o + 1] as number, src.data[o + 2] as number, a);
        }
      }
    },
    params: opts.params ?? {},
    seed,
    brushSize: opts.brushSize ?? 20,
    brushHardness: 0.5,
    color: { r: 0.8, g: 0.1, b: 0.1, a: 1 },
  };
  if (opts.dabAs !== false) {
    ctx.dabAs = (points, style) => {
      hs.dabs.push({ points: points.map((p) => ({ ...p })), style });
      const c = style.color ? [Math.round(style.color.r * 255), Math.round(style.color.g * 255), Math.round(style.color.b * 255)] : [20, 20, 20];
      stamp(points, c as [number, number, number], 2 * (style.sizeScale ?? 1), style.opacity ?? 1);
    };
  }
  if (opts.clearScratch !== false) {
    ctx.clearScratch = (r) => {
      for (let y = Math.max(0, r.y); y < Math.min(h, r.y + r.h); y++) {
        for (let x = Math.max(0, r.x); x < Math.min(w, r.x + r.w); x++) scratch.data.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 4);
      }
    };
  }
  hs.ctx = ctx;
  return hs;
}

export function pt(x: number, y: number, t = 0, pressure = 0.8): InputPoint {
  return { x, y, pressure, tiltX: 0, tiltY: 0, twist: 0, t, pointer: "pen" };
}

/** A gentle curve across the harness picture, as `n` points. */
export function curvePoints(n = 24, w = 96, h = 96): InputPoint[] {
  const pts: InputPoint[] = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    pts.push(pt(w * (0.2 + 0.6 * u), h * (0.5 + 0.2 * Math.sin(u * Math.PI * 1.5)), i * 8));
  }
  return pts;
}

/** Runs a whole stroke (begin, extend in `chunk`-sized batches, end, steps to rest, flush). Returns the number of steps taken. */
export async function runStroke(tool: LabTool, h: Harness, points: InputPoint[], chunk = 4, maxSteps = 1000): Promise<number> {
  const [first, ...rest] = points;
  if (!first) return 0;
  tool.onStrokeBegin(h.ctx, first);
  for (let i = 0; i < rest.length; i += chunk) tool.onStrokeExtend(h.ctx, rest.slice(i, i + chunk));
  tool.onStrokeEnd(h.ctx);
  let steps = 0;
  if (tool.step) {
    while (steps < maxSteps) {
      const more = tool.step(h.ctx, steps);
      steps++;
      if (!more) break;
    }
  }
  await flushTool(tool);
  return steps;
}

/** A cheap order-sensitive hash of an image's bytes. */
export function hashImage(img: ImageData): string {
  let h = 2166136261;
  for (let i = 0; i < img.data.length; i++) {
    h ^= img.data[i] as number;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function nonEmpty(img: ImageData): number {
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) if ((img.data[i] as number) > 0) n++;
  return n;
}
