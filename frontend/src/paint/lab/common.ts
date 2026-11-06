// Shared maths and plumbing for the algorithmic Lab tools. Deterministic: no
// clocks, no unseeded randomness; randomness comes from ctx.rng or hashes.

import type { InputPoint, Rect, RGBA } from "../engine/types";
import { ext } from "./ext";
import type { LabContext, LabParams } from "./types";

export const DEFAULT_RADIUS = 16;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}

export function num(p: LabParams, id: string, fallback: number): number {
  const v = p[id];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
export function str(p: LabParams, id: string, fallback: string): string {
  const v = p[id];
  return typeof v === "string" ? v : fallback;
}
export function bool(p: LabParams, id: string, fallback: boolean): boolean {
  const v = p[id];
  return typeof v === "boolean" ? v : fallback;
}

/** Brush radius in px: the engine's brush size, or a default. */
export function strokeRadius(ctx: LabContext): number {
  const s = ext(ctx).brushSize;
  return s && s > 0 ? s / 2 : DEFAULT_RADIUS;
}
export function strokeHardness(ctx: LabContext): number {
  const h = ext(ctx).brushHardness;
  return h === undefined ? 0.5 : clamp(h, 0, 1);
}

/** Linear 0..1 colour to an sRGB byte triple. */
export function colorBytes(c: RGBA): [number, number, number] {
  const f = (v: number) => {
    const x = clamp(v, 0, 1);
    return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055));
  };
  return [f(c.r), f(c.g), f(c.b)];
}
export const FALLBACK_COLOR: RGBA = { r: 0.02, g: 0.02, b: 0.02, a: 1 };
export function currentColor(ctx: LabContext): RGBA {
  return ext(ctx).color ?? FALLBACK_COLOR;
}

// ---- hashing and noise (all pure) -----------------------------------------

/** 0..1 from integer lattice coordinates and a salt. */
export function hash2(x: number, y: number, salt: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise, 0..1. */
export function valueNoise(x: number, y: number, salt: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, salt);
  const b = hash2(xi + 1, yi, salt);
  const c = hash2(xi, yi + 1, salt);
  const d = hash2(xi + 1, yi + 1, salt);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/** Two octaves of value noise, 0..1. */
export function fbm(x: number, y: number, salt: number): number {
  return (valueNoise(x, y, salt) * 2 + valueNoise(x * 2.03 + 11.7, y * 2.03 - 5.3, salt + 1)) / 3;
}

/** Curl of the noise field: a divergence-free direction (not normalised). */
export function curl(x: number, y: number, salt: number, eps = 0.05): [number, number] {
  const dx = valueNoise(x + eps, y, salt) - valueNoise(x - eps, y, salt);
  const dy = valueNoise(x, y + eps, salt) - valueNoise(x, y - eps, salt);
  return [dy / (2 * eps), -dx / (2 * eps)];
}

// ---- images ----------------------------------------------------------------

export function makeImage(w: number, h: number, data?: Uint8ClampedArray): ImageData {
  const d = data ?? new Uint8ClampedArray(w * h * 4);
  if (typeof ImageData !== "undefined") return new ImageData(d as Uint8ClampedArray<ArrayBuffer>, w, h);
  return { data: d, width: w, height: h, colorSpace: "srgb" } as ImageData;
}

export function luma(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Premultiplied bilinear sample of straight RGBA bytes at pixel coordinates (centres at +0.5). Returns straight r,g,b and alpha 0..255. */
export function sampleBilinear(src: ImageData, x: number, y: number, out: number[] = [0, 0, 0, 0]): number[] {
  const w = src.width;
  const h = src.height;
  const px = x - 0.5;
  const py = y - 0.5;
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const fx = px - x0;
  const fy = py - y0;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const xx = clamp(x0 + i, 0, w - 1);
      const yy = clamp(y0 + j, 0, h - 1);
      const wt = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      const k = (yy * w + xx) * 4;
      const al = (src.data[k + 3] as number) / 255;
      r += (src.data[k] as number) * al * wt;
      g += (src.data[k + 1] as number) * al * wt;
      b += (src.data[k + 2] as number) * al * wt;
      a += al * wt;
    }
  }
  if (a > 1e-6) {
    out[0] = r / a;
    out[1] = g / a;
    out[2] = b / a;
  } else {
    out[0] = out[1] = out[2] = 0;
  }
  out[3] = a * 255;
  return out;
}

/** Integer rect enclosing the points, grown by pad. At least 1x1. */
export function pointsBounds(points: InputPoint[], pad: number): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 1, h: 1 };
  const ix = Math.floor(x0 - pad);
  const iy = Math.floor(y0 - pad);
  return { x: ix, y: iy, w: Math.max(1, Math.ceil(x1 + pad) - ix), h: Math.max(1, Math.ceil(y1 + pad) - iy) };
}

export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return b;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The mask (as ImageData, alpha = coverage) of a coverage grid. */
export function maskFromCoverage(cov: Float32Array, w: number, h: number): ImageData {
  const img = makeImage(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = Math.round(clamp(cov[i] as number, 0, 1) * 255);
    img.data[i * 4] = 255;
    img.data[i * 4 + 1] = 255;
    img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = v;
  }
  return img;
}

export function stampFalloff(d: number, r: number, hardness: number): number {
  if (d >= r) return 0;
  const inner = r * hardness;
  if (d <= inner) return 1;
  const t = (d - inner) / (r - inner);
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Rasterises a stroke's coverage into a grid over `rect` (canvas px) at
 * 1/scale resolution: soft discs stamped along the polyline, max-combined.
 */
export function rasterizeStroke(points: InputPoint[], radius: number, hardness: number, rect: Rect, scale = 1): { w: number; h: number; data: Float32Array } {
  const gw = Math.max(1, Math.ceil(rect.w / scale));
  const gh = Math.max(1, Math.ceil(rect.h / scale));
  const data = new Float32Array(gw * gh);
  const stamp = (x: number, y: number, p: number) => {
    const r = radius * clamp(0.3 + 0.7 * p, 0.3, 1);
    const cx = (x - rect.x) / scale;
    const cy = (y - rect.y) / scale;
    const rs = r / scale;
    const x0 = Math.max(0, Math.floor(cx - rs));
    const x1 = Math.min(gw - 1, Math.ceil(cx + rs));
    const y0 = Math.max(0, Math.floor(cy - rs));
    const y1 = Math.min(gh - 1, Math.ceil(cy + rs));
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cy);
        const a = stampFalloff(d, rs, hardness);
        const k = j * gw + i;
        if (a > (data[k] as number)) data[k] = a;
      }
    }
  };
  const step = Math.max(0.5, radius * 0.2);
  let prev: InputPoint | null = null;
  for (const p of points) {
    if (prev) {
      const L = Math.hypot(p.x - prev.x, p.y - prev.y);
      const n = Math.floor(L / step);
      for (let i = 1; i <= n; i++) {
        const t = i / (n + 1);
        stamp(lerp(prev.x, p.x, t), lerp(prev.y, p.y, t), lerp(prev.pressure, p.pressure, t));
      }
    }
    stamp(p.x, p.y, p.pressure);
    prev = p;
  }
  return { w: gw, h: gh, data };
}

/** Largest grid side the live simulations use; bigger areas get coarser cells. */
export const SIM_MAX = 192;
export function simScale(rect: Rect): number {
  return Math.max(1, Math.ceil(Math.max(rect.w, rect.h) / SIM_MAX));
}

/** Bilinear read of a scalar grid at grid coordinates (cell centres at +0.5). */
export function gridAt(g: Float32Array, gw: number, gh: number, x: number, y: number): number {
  const px = x - 0.5;
  const py = y - 0.5;
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const fx = px - x0;
  const fy = py - y0;
  const at = (i: number, j: number) => g[clamp(j, 0, gh - 1) * gw + clamp(i, 0, gw - 1)] as number;
  return lerp(lerp(at(x0, y0), at(x0 + 1, y0), fx), lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), fx), fy);
}

// ---- stroke resampling -----------------------------------------------------

export interface Sample {
  x: number;
  y: number;
  pressure: number;
  t: number;
  /** 0, 1, 2 ... independent of how the input was batched. */
  index: number;
  /** Arc length from the stroke start. */
  dist: number;
  /** Unit tangent. */
  tx: number;
  ty: number;
}

/**
 * Turns a stroke into evenly spaced samples. The samples depend only on the
 * points, never on how they were split into batches, so tools that act per
 * sample are repeatable however the engine delivers input.
 */
export class Resampler {
  private cur: InputPoint | null = null;
  private pending: Sample | null = null;
  private acc = 0;
  private index = 0;
  private dist = 0;

  constructor(private spacing: number) {}

  begin(p: InputPoint): void {
    this.cur = p;
    this.pending = { x: p.x, y: p.y, pressure: p.pressure, t: p.t, index: 0, dist: 0, tx: 1, ty: 0 };
    this.index = 1;
  }

  push(points: InputPoint[]): Sample[] {
    const out: Sample[] = [];
    for (const q of points) {
      const a = this.cur;
      if (!a) {
        this.begin(q);
        continue;
      }
      const L = Math.hypot(q.x - a.x, q.y - a.y);
      if (L < 1e-6) {
        this.cur = q;
        continue;
      }
      const tx = (q.x - a.x) / L;
      const ty = (q.y - a.y) / L;
      if (this.pending) {
        this.pending.tx = tx;
        this.pending.ty = ty;
        out.push(this.pending);
        this.pending = null;
      }
      let s = this.spacing - this.acc;
      while (s <= L) {
        const f = s / L;
        out.push({
          x: a.x + (q.x - a.x) * f,
          y: a.y + (q.y - a.y) * f,
          pressure: lerp(a.pressure, q.pressure, f),
          t: lerp(a.t, q.t, f),
          index: this.index++,
          dist: this.dist + s,
          tx,
          ty,
        });
        s += this.spacing;
      }
      this.acc = L + this.spacing - s;
      this.dist += L;
      this.cur = q;
    }
    return out;
  }

  /** A click (no movement) still yields its one sample. */
  finish(): Sample[] {
    if (this.pending) {
      const s = this.pending;
      this.pending = null;
      return [s];
    }
    return [];
  }
}

// ---- async work ------------------------------------------------------------

/** Runs jobs one after another; flush() resolves when the queue is empty. */
export class Serial {
  private tail: Promise<void> = Promise.resolve();
  private error: unknown = null;
  run(job: () => Promise<void> | void): void {
    this.tail = this.tail.then(async () => {
      try {
        await job();
      } catch (e) {
        if (this.error === null) this.error = e;
      }
    });
  }
  async flush(): Promise<void> {
    await this.tail;
    if (this.error !== null) {
      const e = this.error;
      this.error = null;
      throw e;
    }
  }
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/**
 * The stroke's working copy of the layer: tiles are pulled from the stroke-start
 * snapshot on first touch, and a tool can write its changes back so later dabs
 * read what earlier dabs made (Feedback).
 */
export class LocalCanvas {
  private tiles = new Map<string, Uint8ClampedArray>();
  constructor(private ctx: LabContext, private ts = 64) {}

  async ensure(r: Rect): Promise<void> {
    const ts = this.ts;
    const jobs: Promise<void>[] = [];
    for (let ty = Math.floor(r.y / ts); ty <= Math.floor((r.y + r.h - 1) / ts); ty++) {
      for (let tx = Math.floor(r.x / ts); tx <= Math.floor((r.x + r.w - 1) / ts); tx++) {
        const key = `${tx},${ty}`;
        if (this.tiles.has(key)) continue;
        const tile = new Uint8ClampedArray(ts * ts * 4);
        this.tiles.set(key, tile);
        jobs.push(
          this.ctx.snapshot({ x: tx * ts, y: ty * ts, w: ts, h: ts }).then((img) => {
            if (img.width === ts && img.height === ts) tile.set(img.data);
          }),
        );
      }
    }
    await Promise.all(jobs);
  }

  read(r: Rect): ImageData {
    const ts = this.ts;
    const img = makeImage(r.w, r.h);
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const gx = r.x + x;
        const gy = r.y + y;
        const t = this.tiles.get(`${Math.floor(gx / ts)},${Math.floor(gy / ts)}`);
        if (!t) continue;
        const k = (mod(gy, ts) * ts + mod(gx, ts)) * 4;
        const o = (y * r.w + x) * 4;
        img.data[o] = t[k] as number;
        img.data[o + 1] = t[k + 1] as number;
        img.data[o + 2] = t[k + 2] as number;
        img.data[o + 3] = t[k + 3] as number;
      }
    }
    return img;
  }

  /** Blends img into the copy over r, by weight (0..1 per pixel). */
  write(r: Rect, img: ImageData, weight: Float32Array): void {
    const ts = this.ts;
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const w = weight[y * r.w + x] as number;
        if (w <= 0) continue;
        const gx = r.x + x;
        const gy = r.y + y;
        const t = this.tiles.get(`${Math.floor(gx / ts)},${Math.floor(gy / ts)}`);
        if (!t) continue;
        const k = (mod(gy, ts) * ts + mod(gx, ts)) * 4;
        const o = (y * r.w + x) * 4;
        const ao = (t[k + 3] as number) / 255;
        const an = (img.data[o + 3] as number) / 255;
        const a = lerp(ao, an, w);
        for (let c = 0; c < 3; c++) {
          const po = (t[k + c] as number) * ao;
          const pn = (img.data[o + c] as number) * an;
          const p = lerp(po, pn, w);
          t[k + c] = a > 1e-6 ? p / a : 0;
        }
        t[k + 3] = a * 255;
      }
    }
  }
}

/**
 * Shows an image that is re-rendered as a whole (Pixel sort, Smear, RD, Ink):
 * clears the scratch first when the engine can; otherwise only the final render
 * is composited, so nothing accumulates. Returns whether it composited.
 */
export function present(ctx: LabContext, rect: Rect, img: ImageData, mask: ImageData | undefined, final: boolean): boolean {
  const x = ext(ctx);
  if (x.clearScratch) {
    x.clearScratch(rect);
    ctx.composite(img, rect, mask);
    return true;
  }
  if (final) {
    ctx.composite(img, rect, mask);
    return true;
  }
  return false;
}
