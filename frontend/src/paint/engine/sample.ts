// Resampling and geometric transforms on premultiplied buffers (CPU). Used by
// Transform commit, resizeCanvas/resample, Liquify and the adjustments.

import { newBuf, type PixelBuf } from "./pixels";
import type { Point } from "./types";

/** Premultiplied bilinear sample at continuous (fx, fy); pixel i has its centre at i + 0.5. Outside = transparent. */
export function sampleBilinear(src: PixelBuf, fx: number, fy: number, out: number[]): void {
  const x = fx - 0.5;
  const y = fy - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  out[0] = out[1] = out[2] = out[3] = 0;
  const d = src.data;
  for (let j = 0; j < 2; j++) {
    const yy = y0 + j;
    if (yy < 0 || yy >= src.h) continue;
    const wy = j ? ty : 1 - ty;
    for (let i = 0; i < 2; i++) {
      const xx = x0 + i;
      if (xx < 0 || xx >= src.w) continue;
      const w = (i ? tx : 1 - tx) * wy;
      const o = (yy * src.w + xx) * 4;
      out[0] = (out[0] as number) + (d[o] as number) * w;
      out[1] = (out[1] as number) + (d[o + 1] as number) * w;
      out[2] = (out[2] as number) + (d[o + 2] as number) * w;
      out[3] = (out[3] as number) + (d[o + 3] as number) * w;
    }
  }
}

const cr = (t: number, p0: number, p1: number, p2: number, p3: number) =>
  0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);

/** Catmull-Rom bicubic; clamps colour to alpha so the premultiplied result stays valid. */
export function sampleBicubic(src: PixelBuf, fx: number, fy: number, out: number[]): void {
  const x = fx - 0.5;
  const y = fy - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const d = src.data;
  const at = (xx: number, yy: number, c: number) => (xx < 0 || yy < 0 || xx >= src.w || yy >= src.h ? 0 : (d[(yy * src.w + xx) * 4 + c] as number));
  for (let c = 0; c < 4; c++) {
    const rows: number[] = [];
    for (let j = -1; j <= 2; j++) rows.push(cr(tx, at(x0 - 1, y0 + j, c), at(x0, y0 + j, c), at(x0 + 1, y0 + j, c), at(x0 + 2, y0 + j, c)));
    out[c] = cr(ty, rows[0] as number, rows[1] as number, rows[2] as number, rows[3] as number);
  }
  const a = Math.max(0, Math.min(255, out[3] as number));
  out[3] = a;
  for (let c = 0; c < 3; c++) out[c] = Math.max(0, Math.min(a, out[c] as number));
}

export type Resample = "bilinear" | "bicubic";

/** [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Affine = [number, number, number, number, number, number];

export function applyAffine(m: Affine, x: number, y: number): Point {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export function invertAffine(m: Affine): Affine | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function multiplyAffine(p: Affine, q: Affine): Affine {
  // p after q.
  return [
    p[0] * q[0] + p[2] * q[1],
    p[1] * q[0] + p[3] * q[1],
    p[0] * q[2] + p[2] * q[3],
    p[1] * q[2] + p[3] * q[3],
    p[0] * q[4] + p[2] * q[5] + p[4],
    p[1] * q[4] + p[3] * q[5] + p[5],
  ];
}

export interface Placed {
  /** Canvas position of buf's top-left. */
  x: number;
  y: number;
  buf: PixelBuf;
}

function bbox(pts: Point[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

const isUnit = (v: number) => Math.abs(Math.abs(v) - 1) < 1e-9 || Math.abs(v) < 1e-9;

/** A flip / quarter turn with whole-pixel translation: moved by index, exactly. */
export function isExactAffine(m: Affine): boolean {
  if (!(isUnit(m[0]) && isUnit(m[1]) && isUnit(m[2]) && isUnit(m[3]))) return false;
  const det = m[0] * m[3] - m[1] * m[2];
  return Math.abs(Math.abs(det) - 1) < 1e-9;
}

/** Move `src` (placed at sx, sy) through an affine map. Exact for flips/quarter turns, else resampled. */
export function transformAffine(src: Placed, m: Affine, mode: Resample): Placed | null {
  const w = src.buf.w;
  const h = src.buf.h;
  const corners = [applyAffine(m, src.x, src.y), applyAffine(m, src.x + w, src.y), applyAffine(m, src.x + w, src.y + h), applyAffine(m, src.x, src.y + h)];
  const bb = bbox(corners);
  if (isExactAffine(m)) {
    const x0 = Math.round(bb.x0);
    const y0 = Math.round(bb.y0);
    const ow = Math.round(bb.x1) - x0;
    const oh = Math.round(bb.y1) - y0;
    if (ow <= 0 || oh <= 0) return null;
    const out = newBuf(ow, oh);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const p = applyAffine(m, src.x + i + 0.5, src.y + j + 0.5);
        const dx = Math.floor(p.x) - x0;
        const dy = Math.floor(p.y) - y0;
        if (dx < 0 || dy < 0 || dx >= ow || dy >= oh) continue;
        const so = (j * w + i) * 4;
        out.data.set(src.buf.data.subarray(so, so + 4), (dy * ow + dx) * 4);
      }
    }
    return { x: x0, y: y0, buf: out };
  }
  const inv = invertAffine(m);
  if (!inv) return null;
  const x0 = Math.floor(bb.x0) - 1;
  const y0 = Math.floor(bb.y0) - 1;
  const ow = Math.ceil(bb.x1) + 1 - x0;
  const oh = Math.ceil(bb.y1) + 1 - y0;
  if (ow <= 0 || oh <= 0 || ow * oh > 200e6) return null;
  const out = newBuf(ow, oh);
  const px = [0, 0, 0, 0];
  const sample = mode === "bicubic" ? sampleBicubic : sampleBilinear;
  for (let j = 0; j < oh; j++) {
    for (let i = 0; i < ow; i++) {
      const X = x0 + i + 0.5;
      const Y = y0 + j + 0.5;
      const sx = inv[0] * X + inv[2] * Y + inv[4] - src.x;
      const sy = inv[1] * X + inv[3] * Y + inv[5] - src.y;
      if (sx < -1 || sy < -1 || sx > w + 1 || sy > h + 1) continue;
      sample(src.buf, sx, sy, px);
      const o = (j * ow + i) * 4;
      out.data[o] = px[0] as number;
      out.data[o + 1] = px[1] as number;
      out.data[o + 2] = px[2] as number;
      out.data[o + 3] = px[3] as number;
    }
  }
  return { x: x0, y: y0, buf: out };
}

// ---- perspective ("distort") ----

type M3 = number[]; // row-major 3×3

function inv3(m: M3): M3 | null {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

/** Homography taking the unit square (0,0)(1,0)(1,1)(0,1) to four points. */
export function unitSquareTo(q: Point[]): M3 | null {
  const [p0, p1, p2, p3] = q as [Point, Point, Point, Point];
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;
  let g: number;
  let h: number;
  if (Math.abs(dx3) < 1e-12 && Math.abs(dy3) < 1e-12) {
    g = 0;
    h = 0;
  } else {
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) < 1e-12) return null;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  return [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x, p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y, g, h, 1];
}

/** Warp `src` so its corners land on `corners` (TL, TR, BR, BL). */
export function transformCorners(src: Placed, corners: Point[], mode: Resample): Placed | null {
  const H = unitSquareTo(corners);
  const Hi = H ? inv3(H) : null;
  if (!Hi) return null;
  const bb = bbox(corners);
  const x0 = Math.floor(bb.x0) - 1;
  const y0 = Math.floor(bb.y0) - 1;
  const ow = Math.ceil(bb.x1) + 1 - x0;
  const oh = Math.ceil(bb.y1) + 1 - y0;
  if (ow <= 0 || oh <= 0 || ow * oh > 200e6) return null;
  const out = newBuf(ow, oh);
  const px = [0, 0, 0, 0];
  const sample = mode === "bicubic" ? sampleBicubic : sampleBilinear;
  const w = src.buf.w;
  const h = src.buf.h;
  for (let j = 0; j < oh; j++) {
    for (let i = 0; i < ow; i++) {
      const X = x0 + i + 0.5;
      const Y = y0 + j + 0.5;
      const z = (Hi[6] as number) * X + (Hi[7] as number) * Y + (Hi[8] as number);
      if (Math.abs(z) < 1e-12) continue;
      const u = ((Hi[0] as number) * X + (Hi[1] as number) * Y + (Hi[2] as number)) / z;
      const v = ((Hi[3] as number) * X + (Hi[4] as number) * Y + (Hi[5] as number)) / z;
      if (u < -0.002 || v < -0.002 || u > 1.002 || v > 1.002) continue;
      sample(src.buf, u * w, v * h, px);
      const o = (j * ow + i) * 4;
      out.data[o] = px[0] as number;
      out.data[o + 1] = px[1] as number;
      out.data[o + 2] = px[2] as number;
      out.data[o + 3] = px[3] as number;
    }
  }
  return { x: x0, y: y0, buf: out };
}

// ---- warp (4×4 mesh) ----

const SUB = 8;

function catmull(a: Point, b: Point, c: Point, d: Point, t: number): Point {
  return { x: cr(t, a.x, b.x, c.x, d.x), y: cr(t, a.y, b.y, c.y, d.y) };
}

/** The mesh (16 destination points, row-major, over a uniform source grid) as a dense vertex grid. */
export function meshGrid(mesh: Point[]): Point[][] {
  const g = (r: number, c: number) => mesh[Math.max(0, Math.min(3, r)) * 4 + Math.max(0, Math.min(3, c))] as Point;
  const n = 3 * SUB + 1;
  const rows: Point[][] = [];
  // Interpolate along each mesh row, then down the columns.
  const rowSamples: Point[][] = [];
  for (let r = 0; r < 4; r++) {
    const line: Point[] = [];
    for (let k = 0; k < n; k++) {
      const f = (k / SUB) % 1;
      const seg = Math.min(2, Math.floor(k / SUB));
      line.push(k === n - 1 ? g(r, 3) : catmull(g(r, seg - 1), g(r, seg), g(r, seg + 1), g(r, seg + 2), f));
    }
    rowSamples.push(line);
  }
  for (let k = 0; k < n; k++) {
    const f = (k / SUB) % 1;
    const seg = Math.min(2, Math.floor(k / SUB));
    const row: Point[] = [];
    for (let c = 0; c < n; c++) {
      const col = (r: number) => (rowSamples[Math.max(0, Math.min(3, r))] as Point[])[c] as Point;
      row.push(k === n - 1 ? col(3) : catmull(col(seg - 1), col(seg), col(seg + 1), col(seg + 2), f));
    }
    rows.push(row);
  }
  return rows;
}

/** Identity mesh over a rect: 4×4 points on a uniform grid. */
export function identityMesh(x: number, y: number, w: number, h: number): Point[] {
  const out: Point[] = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out.push({ x: x + (w * c) / 3, y: y + (h * r) / 3 });
  return out;
}

/** Warp by a 4×4 mesh: triangles of the dense grid, each sampled from the source. */
export function transformMesh(src: Placed, mesh: Point[], mode: Resample): Placed | null {
  const grid = meshGrid(mesh);
  const n = grid.length;
  const all: Point[] = [];
  for (const r of grid) all.push(...r);
  const bb = bbox(all);
  const x0 = Math.floor(bb.x0) - 1;
  const y0 = Math.floor(bb.y0) - 1;
  const ow = Math.ceil(bb.x1) + 1 - x0;
  const oh = Math.ceil(bb.y1) + 1 - y0;
  if (ow <= 0 || oh <= 0 || ow * oh > 200e6) return null;
  const out = newBuf(ow, oh);
  const px = [0, 0, 0, 0];
  const sample = mode === "bicubic" ? sampleBicubic : sampleBilinear;
  const w = src.buf.w;
  const h = src.buf.h;
  const tri = (a: Point, b: Point, c: Point, ua: number, va: number, ub: number, vb: number, uc: number, vc: number) => {
    const minx = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x) - x0 - 0.5));
    const maxx = Math.min(ow - 1, Math.ceil(Math.max(a.x, b.x, c.x) - x0 + 0.5));
    const miny = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y) - y0 - 0.5));
    const maxy = Math.min(oh - 1, Math.ceil(Math.max(a.y, b.y, c.y) - y0 + 0.5));
    const den = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(den) < 1e-12) return;
    for (let j = miny; j <= maxy; j++) {
      for (let i = minx; i <= maxx; i++) {
        const X = x0 + i + 0.5;
        const Y = y0 + j + 0.5;
        const l1 = ((b.y - c.y) * (X - c.x) + (c.x - b.x) * (Y - c.y)) / den;
        const l2 = ((c.y - a.y) * (X - c.x) + (a.x - c.x) * (Y - c.y)) / den;
        const l3 = 1 - l1 - l2;
        const e = -0.02;
        if (l1 < e || l2 < e || l3 < e) continue;
        const u = l1 * ua + l2 * ub + l3 * uc;
        const v = l1 * va + l2 * vb + l3 * vc;
        sample(src.buf, u * w, v * h, px);
        const o = (j * ow + i) * 4;
        out.data[o] = px[0] as number;
        out.data[o + 1] = px[1] as number;
        out.data[o + 2] = px[2] as number;
        out.data[o + 3] = px[3] as number;
      }
    }
  };
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const p00 = (grid[r] as Point[])[c] as Point;
      const p10 = (grid[r] as Point[])[c + 1] as Point;
      const p01 = (grid[r + 1] as Point[])[c] as Point;
      const p11 = (grid[r + 1] as Point[])[c + 1] as Point;
      const u0 = c / (n - 1);
      const u1 = (c + 1) / (n - 1);
      const v0 = r / (n - 1);
      const v1 = (r + 1) / (n - 1);
      tri(p00, p10, p01, u0, v0, u1, v0, u0, v1);
      tri(p10, p11, p01, u1, v0, u1, v1, u0, v1);
    }
  }
  return { x: x0, y: y0, buf: out };
}

/** Resize a whole buffer (canvas resample): footprint-averaged when shrinking, bilinear/bicubic when growing. */
export function resizeBuf(src: PixelBuf, w: number, h: number, mode: Resample = "bilinear"): PixelBuf {
  const out = newBuf(w, h);
  const sx = src.w / w;
  const sy = src.h / h;
  const nx = Math.max(1, Math.min(8, Math.ceil(sx)));
  const ny = Math.max(1, Math.min(8, Math.ceil(sy)));
  const px = [0, 0, 0, 0];
  const sample = mode === "bicubic" && nx === 1 && ny === 1 ? sampleBicubic : sampleBilinear;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let jj = 0; jj < ny; jj++) {
        for (let ii = 0; ii < nx; ii++) {
          sample(src, (i + (ii + 0.5) / nx) * sx, (j + (jj + 0.5) / ny) * sy, px);
          r += px[0] as number;
          g += px[1] as number;
          b += px[2] as number;
          a += px[3] as number;
        }
      }
      const k = 1 / (nx * ny);
      const o = (j * w + i) * 4;
      out.data[o] = r * k;
      out.data[o + 1] = g * k;
      out.data[o + 2] = b * k;
      out.data[o + 3] = a * k;
    }
  }
  return out;
}
