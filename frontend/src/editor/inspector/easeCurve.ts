/**
 * Pure helpers of the keyframe ease picker (Phase 21 SPEC §B3): the picker's
 * choices, the bezier each built-in ease looks like (so "Custom" starts from
 * the current curve), and the curve editor's coordinate maths.
 */
import type { Key } from "@/viz/edit/types";

export type Bez = [number, number, number, number];

export const EASE_CHOICES: ReadonlyArray<{ value: Key["ease"]; label: string; tip: string }> = [
  { value: "linear", label: "Linear", tip: "A straight line from this key to the next" },
  { value: "hold", label: "Hold", tip: "Keep this value until the next key, then jump" },
  { value: "in", label: "Ease in", tip: "Start slowly, then speed up" },
  { value: "out", label: "Ease out", tip: "Start fast, then slow down to the next key" },
  { value: "inout", label: "Ease in-out", tip: "Slow at both ends, fast in the middle" },
  { value: "ease", label: "Smooth", tip: "A gentle S-curve between the keys" },
  { value: "bezier", label: "Custom", tip: "Draw your own curve with two handles" },
];

/** The cubic-bezier a built-in ease looks like; used to start a custom curve from the current one. */
export function curveOfEase(ease: Key["ease"], bez?: Bez): Bez {
  switch (ease) {
    case "in":
      return [0.32, 0, 0.67, 0];
    case "out":
      return [0.33, 1, 0.68, 1];
    case "inout":
      return [0.65, 0, 0.35, 1];
    case "ease":
      return [0.42, 0, 0.58, 1];
    case "bezier":
      return bez ? [...bez] : [0.25, 0.1, 0.25, 1];
    default:
      return [0, 0, 1, 1];
  }
}

/** Editor size (CSS px) and the padding around the 0..1 box. */
export const CURVE_W = 120;
export const CURVE_H = 80;
export const CURVE_PAD = 10;

export interface YRange {
  lo: number;
  hi: number;
}

/** The y range shown: at least 0..1, widened by handles that overshoot. */
export function curveRange(bez: Bez): YRange {
  return { lo: Math.min(0, bez[1], bez[3]) - 0.1, hi: Math.max(1, bez[1], bez[3]) + 0.1 };
}

export interface CurvePoint {
  x: number;
  y: number;
}

/** Curve space (x 0..1, y up) → editor px. */
export function curveToPx(p: CurvePoint, r: YRange): CurvePoint {
  const w = CURVE_W - 2 * CURVE_PAD;
  const h = CURVE_H - 2 * CURVE_PAD;
  return { x: CURVE_PAD + p.x * w, y: CURVE_PAD + (1 - (p.y - r.lo) / (r.hi - r.lo)) * h };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Editor px → curve space; x clamps to 0..1 and y to −1..2 (the schema's limits). */
export function pxToCurve(p: CurvePoint, r: YRange): CurvePoint {
  const w = CURVE_W - 2 * CURVE_PAD;
  const h = CURVE_H - 2 * CURVE_PAD;
  const x = (p.x - CURVE_PAD) / w;
  const y = r.lo + (1 - (p.y - CURVE_PAD) / h) * (r.hi - r.lo);
  return { x: round3(clamp(x, 0, 1)), y: round3(clamp(y, -1, 2)) };
}

/** Moves handle 1 or 2 to a curve point. */
export function moveHandle(bez: Bez, handle: 1 | 2, to: CurvePoint): Bez {
  const next: Bez = [...bez];
  const i = handle === 1 ? 0 : 2;
  next[i] = round3(clamp(to.x, 0, 1));
  next[i + 1] = round3(clamp(to.y, -1, 2));
  return next;
}

/** Keyboard nudge of a handle by (dx, dy) curve units. */
export function nudgeHandle(bez: Bez, handle: 1 | 2, dx: number, dy: number): Bez {
  const i = handle === 1 ? 0 : 2;
  return moveHandle(bez, handle, { x: (bez[i] as number) + dx, y: (bez[i + 1] as number) + dy });
}

/** The SVG path of the curve in editor px. */
export function curvePath(bez: Bez, r: YRange): string {
  const p0 = curveToPx({ x: 0, y: 0 }, r);
  const p1 = curveToPx({ x: bez[0], y: bez[1] }, r);
  const p2 = curveToPx({ x: bez[2], y: bez[3] }, r);
  const p3 = curveToPx({ x: 1, y: 1 }, r);
  const f = (p: CurvePoint) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  return `M ${f(p0)} C ${f(p1)} ${f(p2)} ${f(p3)}`;
}
