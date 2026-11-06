/**
 * Pure maths for the on-canvas transform handles. An affine is [a, b, c, d, e, f]:
 * x' = a·x + c·y + e, y' = b·x + d·y + f (the engine's `transform.set({ matrix })`).
 */
import type { Point, Rect } from "@/paint/engine/types";

export type Affine = [number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

export const apply = (m: readonly number[], p: Point): Point => ({ x: (m[0] as number) * p.x + (m[2] as number) * p.y + (m[4] as number), y: (m[1] as number) * p.x + (m[3] as number) * p.y + (m[5] as number) });

/** `g` applied after `m`. */
export function compose(g: readonly number[], m: readonly number[]): Affine {
  const [g0, g1, g2, g3, g4, g5] = g as [number, number, number, number, number, number];
  const [m0, m1, m2, m3, m4, m5] = m as [number, number, number, number, number, number];
  return [g0 * m0 + g2 * m1, g1 * m0 + g3 * m1, g0 * m2 + g2 * m3, g1 * m2 + g3 * m3, g0 * m4 + g2 * m5 + g4, g1 * m4 + g3 * m5 + g5];
}

export function invert(m: readonly number[]): Affine | null {
  const [a, b, c, d, e, f] = m as [number, number, number, number, number, number];
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export const translate = (m: readonly number[], dx: number, dy: number): Affine => compose([1, 0, 0, 1, dx, dy], m);

/** Rotation by `rad` about `c`, applied after `m`. */
export function rotateAbout(m: readonly number[], c: Point, rad: number): Affine {
  const cs = Math.cos(rad);
  const sn = Math.sin(rad);
  return compose([cs, sn, -sn, cs, c.x - cs * c.x + sn * c.y, c.y - sn * c.x - cs * c.y], m);
}

/** A handle on the lifted rectangle: 0, 0.5 or 1 along each axis (so (0,0) is the top-left corner). */
export interface HandleId {
  hx: 0 | 0.5 | 1;
  hy: 0 | 0.5 | 1;
}

export const HANDLES: HandleId[] = [
  { hx: 0, hy: 0 },
  { hx: 0.5, hy: 0 },
  { hx: 1, hy: 0 },
  { hx: 1, hy: 0.5 },
  { hx: 1, hy: 1 },
  { hx: 0.5, hy: 1 },
  { hx: 0, hy: 1 },
  { hx: 0, hy: 0.5 },
];

const MIN_SCALE = 0.02;
const clampScale = (k: number): number => (Math.abs(k) < MIN_SCALE ? (k < 0 ? -MIN_SCALE : MIN_SCALE) : k);

/** The source-space point of a handle. */
export const sourcePoint = (r: Rect, h: HandleId): Point => ({ x: r.x + h.hx * r.w, y: r.y + h.hy * r.h });

/** The handle's position on the canvas under `m`. */
export const handlePoint = (m: readonly number[], r: Rect, h: HandleId): Point => apply(m, sourcePoint(r, h));

/** The rect's centre on the canvas under `m`. */
export const centreOf = (m: readonly number[], r: Rect): Point => apply(m, { x: r.x + r.w / 2, y: r.y + r.h / 2 });

/**
 * Drag a scale handle so it follows `p`, with the opposite handle held still.
 * `uniform` keeps proportions on corner handles; edge handles only scale one axis.
 */
export function scaleHandle(m: readonly number[], r: Rect, h: HandleId, p: Point, uniform: boolean): Affine {
  const inv = invert(m);
  if (!inv) return m as Affine;
  const q = apply(inv, p);
  const hp = sourcePoint(r, h);
  const ap = sourcePoint(r, { hx: (1 - h.hx) as HandleId["hx"], hy: (1 - h.hy) as HandleId["hy"] });
  let kx = h.hx === 0.5 ? 1 : clampScale((q.x - ap.x) / (hp.x - ap.x));
  let ky = h.hy === 0.5 ? 1 : clampScale((q.y - ap.y) / (hp.y - ap.y));
  if (uniform) {
    if (h.hx === 0.5) kx = ky;
    else if (h.hy === 0.5) ky = kx;
    else kx = ky = (kx + ky) / 2;
  }
  return compose(m, [kx, 0, 0, ky, ap.x * (1 - kx), ap.y * (1 - ky)]);
}

/** Rotate by the angle the pointer swept around the centre between `from` and `to`; `snap` rounds the total to 15°. */
export function rotateDrag(start: readonly number[], r: Rect, from: Point, to: Point, snap: boolean): Affine {
  const c = centreOf(start, r);
  let d = Math.atan2(to.y - c.y, to.x - c.x) - Math.atan2(from.y - c.y, from.x - c.x);
  if (snap) {
    const step = Math.PI / 12;
    d = Math.round(d / step) * step;
  }
  return rotateAbout(start, c, d);
}

/** Moves one point of a corner list or a mesh. */
export function movePoint(points: readonly Point[], i: number, p: Point): Point[] {
  return points.map((q, k) => (k === i ? { x: p.x, y: p.y } : { ...q }));
}
