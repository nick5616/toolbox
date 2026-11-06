// Dynamics curves: sorted control points, monotone cubic (Fritsch–Carlson)
// between them, baked into a lookup table so the stroke path never allocates.

import type { Curve } from "./schema";

const LUT = 256;

/** Evaluate a curve directly (tests, editors). Empty/invalid curves are the identity. */
export function evalCurve(curve: Curve | undefined, x: number): number {
  const pts = sortedPoints(curve);
  if (pts.length === 0) return clamp01(x);
  return evalPts(pts, clamp01(x));
}

function sortedPoints(curve: Curve | undefined): Array<[number, number]> {
  if (!curve || curve.length === 0) return [];
  return curve
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p): [number, number] => [clamp01(p[0]), clamp01(p[1])])
    .sort((a, b) => a[0] - b[0]);
}

function evalPts(pts: Array<[number, number]>, x: number): number {
  const n = pts.length;
  const first = pts[0] as [number, number];
  const last = pts[n - 1] as [number, number];
  if (n === 1) return first[1];
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  // Slopes and tangents.
  const dk: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i] as [number, number];
    const b = pts[i + 1] as [number, number];
    dk.push((b[1] - a[1]) / Math.max(1e-9, b[0] - a[0]));
  }
  m.push(dk[0] as number);
  for (let i = 1; i < n - 1; i++) {
    const d0 = dk[i - 1] as number;
    const d1 = dk[i] as number;
    m.push(d0 * d1 <= 0 ? 0 : (d0 + d1) / 2);
  }
  m.push(dk[n - 2] as number);
  for (let i = 0; i < n - 1; i++) {
    const d = dk[i] as number;
    if (d === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const al = (m[i] as number) / d;
    const be = (m[i + 1] as number) / d;
    const s = al * al + be * be;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * al * d;
      m[i + 1] = t * be * d;
    }
  }
  let i = 0;
  while (i < n - 2 && x > (pts[i + 1] as [number, number])[0]) i++;
  const a = pts[i] as [number, number];
  const b = pts[i + 1] as [number, number];
  const h = b[0] - a[0];
  const t = (x - a[0]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const v = (2 * t3 - 3 * t2 + 1) * a[1] + (t3 - 2 * t2 + t) * h * (m[i] as number) + (-2 * t3 + 3 * t2) * b[1] + (t3 - t2) * h * (m[i + 1] as number);
  return clamp01(v);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A baked curve: lut(x) is a table lookup with linear interpolation. */
export interface CurveLUT {
  readonly identity: boolean;
  at(x: number): number;
}

export function bakeCurve(curve: Curve | undefined): CurveLUT {
  const pts = sortedPoints(curve);
  if (pts.length === 0) return { identity: true, at: clamp01 };
  const t = new Float32Array(LUT + 1);
  for (let i = 0; i <= LUT; i++) t[i] = evalPts(pts, i / LUT);
  return {
    identity: false,
    at(x: number) {
      const f = clamp01(x) * LUT;
      const i = Math.min(LUT - 1, Math.floor(f));
      const k = f - i;
      return (t[i] as number) * (1 - k) + (t[i + 1] as number) * k;
    },
  };
}
