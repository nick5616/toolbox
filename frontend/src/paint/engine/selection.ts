// Selection masks: pure functions over canvas-sized Uint8 alpha arrays, plus
// the SelectionImpl the engine exposes as `engine.selection`.

import { clamp, makeImageData, type PixelBuf } from "./pixels";
import { floodMask } from "./fill";
import type { Point, Rect, SelectionAPI, SelectMode } from "./types";

/** Antialiased polygon coverage (4 sub-scanlines, exact horizontal spans). */
export function polygonMask(w: number, h: number, pts: Point[]): Uint8Array {
  const out = new Uint8Array(w * h);
  if (pts.length < 3) return out;
  const SUB = 4;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(h - 1, Math.ceil(maxY));
  const acc = new Float32Array(w);
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    acc.fill(0);
    for (let s = 0; s < SUB; s++) {
      const sy = y + (s + 0.5) / SUB;
      xs.length = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i] as Point;
        const b = pts[(i + 1) % pts.length] as Point;
        if ((a.y <= sy && b.y > sy) || (b.y <= sy && a.y > sy)) xs.push(a.x + ((sy - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = clamp(xs[k] as number, 0, w);
        const xb = clamp(xs[k + 1] as number, 0, w);
        if (xb <= xa) continue;
        const ia = Math.floor(xa);
        const ib = Math.min(w - 1, Math.floor(xb));
        if (ia === ib) {
          acc[ia] = (acc[ia] as number) + (xb - xa);
        } else {
          acc[ia] = (acc[ia] as number) + (ia + 1 - xa);
          for (let x = ia + 1; x < ib; x++) acc[x] = (acc[x] as number) + 1;
          acc[ib] = (acc[ib] as number) + (xb - ib);
        }
      }
    }
    for (let x = 0; x < w; x++) out[y * w + x] = Math.round(((acc[x] as number) / SUB) * 255);
  }
  return out;
}

export function rectMask(w: number, h: number, r: Rect): Uint8Array {
  const out = new Uint8Array(w * h);
  const x0 = Math.max(0, Math.round(r.x));
  const y0 = Math.max(0, Math.round(r.y));
  const x1 = Math.min(w, Math.round(r.x + r.w));
  const y1 = Math.min(h, Math.round(r.y + r.h));
  for (let y = y0; y < y1; y++) out.fill(255, y * w + x0, y * w + Math.max(x0, x1));
  return out;
}

/** Ellipse inscribed in r, edge pixels 3×3 supersampled. */
export function ellipseMask(w: number, h: number, r: Rect): Uint8Array {
  const out = new Uint8Array(w * h);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const rx = r.w / 2;
  const ry = r.h / 2;
  if (rx <= 0 || ry <= 0) return out;
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(w - 1, Math.ceil(r.x + r.w));
  const y1 = Math.min(h - 1, Math.ceil(r.y + r.h));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let n = 0;
      for (let j = 0; j < 3; j++) {
        for (let i = 0; i < 3; i++) {
          const dx = (x + (i + 0.5) / 3 - cx) / rx;
          const dy = (y + (j + 0.5) / 3 - cy) / ry;
          if (dx * dx + dy * dy <= 1) n++;
        }
      }
      out[y * w + x] = Math.round((n / 9) * 255);
    }
  }
  return out;
}

export function combine(dst: Uint8Array | null, src: Uint8Array, mode: SelectMode): Uint8Array {
  if (!dst || mode === "replace") return src;
  const out = new Uint8Array(dst.length);
  for (let i = 0; i < out.length; i++) {
    const a = dst[i] as number;
    const b = src[i] as number;
    switch (mode) {
      case "add":
        out[i] = a + b - Math.round((a * b) / 255);
        break;
      case "subtract":
        out[i] = Math.round((a * (255 - b)) / 255);
        break;
      case "intersect":
        out[i] = Math.round((a * b) / 255);
        break;
    }
  }
  return out;
}

export function invertMask(m: Uint8Array): Uint8Array {
  const out = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) out[i] = 255 - (m[i] as number);
  return out;
}

function boxBlur(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return src;
  const tmp = new Float32Array(w * h);
  const out = new Uint8Array(w * h);
  const k = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    let s = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) s += src[row + clamp(x, 0, w - 1)] as number;
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s * k;
      s += (src[row + Math.min(w - 1, x + r + 1)] as number) - (src[row + Math.max(0, x - r)] as number);
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[clamp(y, 0, h - 1) * w + x] as number;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = Math.round(s * k);
      s += (tmp[Math.min(h - 1, y + r + 1) * w + x] as number) - (tmp[Math.max(0, y - r) * w + x] as number);
    }
  }
  return out;
}

/** Gaussian-like feather: three box passes. */
export function featherMask(m: Uint8Array, w: number, h: number, px: number): Uint8Array {
  const r = Math.max(1, Math.round(px / 2));
  let o = m;
  for (let i = 0; i < 3; i++) o = boxBlur(o, w, h, r);
  return o;
}

const INF = 1e20;

/** Squared distance to the nearest "on" pixel (Felzenszwalb & Huttenlocher). */
function distSq(on: (i: number) => boolean, w: number, h: number): Float64Array {
  const d = new Float64Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = on(i) ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  const edt = (len: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s: number;
      for (;;) {
        const p = v[k] as number;
        s = (f[q] as number) + q * q - ((f[p] as number) + p * p);
        s /= 2 * (q - p);
        if (s <= (z[k] as number) && k > 0) k--;
        else break;
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    const out = new Float64Array(len);
    for (let q = 0; q < len; q++) {
      while ((z[k + 1] as number) < q) k++;
      const p = v[k] as number;
      out[q] = (q - p) * (q - p) + (f[p] as number);
    }
    for (let q = 0; q < len; q++) f[q] = out[q] as number;
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = d[y * w + x] as number;
    edt(h);
    for (let y = 0; y < h; y++) d[y * w + x] = f[y] as number;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = d[y * w + x] as number;
    edt(w);
    for (let x = 0; x < w; x++) d[y * w + x] = f[x] as number;
  }
  return d;
}

/** Grow by r px (round); negative shrinks. Soft edges are kept where they already were. */
export function growMask(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r === 0) return m;
  if (r < 0) return invertMask(growMask(invertMask(m), w, h, -r));
  const d = distSq((i) => (m[i] as number) >= 128, w, h);
  const out = new Uint8Array(m.length);
  const rr = r * r;
  for (let i = 0; i < out.length; i++) out[i] = Math.max(m[i] as number, (d[i] as number) <= rr ? 255 : 0);
  return out;
}

export function maskBounds(m: Uint8Array, w: number, h: number): Rect | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (m[y * w + x] !== 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** What the engine gives the selection. */
export interface SelectionHost {
  size(): { w: number; h: number };
  /** Premultiplied pixels of the whole canvas to run the wand on. */
  pixels(sampleAll: boolean): PixelBuf;
  changed(): void;
}

export class SelectionImpl implements SelectionAPI {
  m: Uint8Array | null = null;
  /** Bumped on every change (per-tile selection surfaces are cached by it). */
  version = 0;
  private b: Rect | null = null;
  constructor(private readonly host: SelectionHost) {}

  get active(): boolean {
    return this.m !== null;
  }
  bounds(): Rect | null {
    return this.m ? this.b : null;
  }

  private set(m: Uint8Array | null): void {
    const { w, h } = this.host.size();
    if (m && m.every((v) => v === 0)) m = null;
    this.m = m;
    this.b = m ? maskBounds(m, w, h) : null;
    this.version++;
    this.host.changed();
  }

  /** Resize/reset when the canvas changes size. */
  reset(): void {
    this.set(null);
  }

  private apply(src: Uint8Array, mode: SelectMode = "replace"): void {
    this.set(combine(this.m, src, mode));
  }

  rect(r: Rect, mode?: SelectMode): void {
    const { w, h } = this.host.size();
    this.apply(rectMask(w, h, r), mode);
  }
  ellipse(r: Rect, mode?: SelectMode): void {
    const { w, h } = this.host.size();
    this.apply(ellipseMask(w, h, r), mode);
  }
  lasso(points: Point[], mode?: SelectMode): void {
    const { w, h } = this.host.size();
    this.apply(polygonMask(w, h, points), mode);
  }
  wand(at: Point, opts: { tolerance: number; contiguous: boolean; sampleAll: boolean }, mode?: SelectMode): void {
    const { w, h } = this.host.size();
    const x = Math.floor(at.x);
    const y = Math.floor(at.y);
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const px = this.host.pixels(opts.sampleAll);
    this.apply(floodMask(px.data, w, h, x, y, opts.tolerance, opts.contiguous), mode);
  }
  fromMask(mask: ImageData, at: Point, mode?: SelectMode): void {
    const { w, h } = this.host.size();
    const out = new Uint8Array(w * h);
    const ox = Math.round(at.x);
    const oy = Math.round(at.y);
    for (let y = 0; y < mask.height; y++) {
      const cy = y + oy;
      if (cy < 0 || cy >= h) continue;
      for (let x = 0; x < mask.width; x++) {
        const cx = x + ox;
        if (cx < 0 || cx >= w) continue;
        out[cy * w + cx] = mask.data[(y * mask.width + x) * 4 + 3] as number;
      }
    }
    this.apply(out, mode);
  }
  invert(): void {
    const { w, h } = this.host.size();
    this.set(this.m ? invertMask(this.m) : new Uint8Array(w * h).fill(255));
  }
  feather(px: number): void {
    if (!this.m) return;
    const { w, h } = this.host.size();
    this.set(featherMask(this.m, w, h, px));
  }
  grow(px: number): void {
    if (!this.m) return;
    const { w, h } = this.host.size();
    this.set(growMask(this.m, w, h, px));
  }
  clear(): void {
    if (this.m) this.set(null);
  }
  mask(): ImageData | null {
    if (!this.m) return null;
    const { w, h } = this.host.size();
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < this.m.length; i++) d[i * 4 + 3] = this.m[i] as number;
    return makeImageData(w, h, d);
  }
}
