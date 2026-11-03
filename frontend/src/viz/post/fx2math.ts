/** Pure-TS models of the FX2 (stylize) shader math, used by fx2.test.ts. Mirrors the GLSL in the effect files. */
import { hash01 } from "./px1math";

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Pixelate: block edge in px (1 = identity). */
export function pixelBlock(amount: number, shortSide: number): number {
  return 1 + clamp01(amount) * 0.08 * shortSide;
}
/** The pixel-space sample position (block centre) for pixel coordinate x (centre of pixel = n + 0.5). */
export function pixelCentre(x: number, block: number): number {
  return (Math.floor(x / block) + 0.5) * block;
}

/** Posterize one channel (straight colour) to `levels` steps, mixed by amount. */
export function posterizeChannel(v: number, levels: number, amount: number): number {
  const n = Math.max(2, Math.round(levels)) - 1;
  const q = Math.round(clamp01(v) * n) / n;
  return mix(v, q, clamp01(amount));
}

export type Vec3 = [number, number, number];

/** Duotone: luma gradient map between shadows and highlights, mixed by amount. */
export function duotone(rgb: Vec3, shadows: Vec3, highlights: Vec3, amount: number): Vec3 {
  const l = clamp01(luma(...rgb));
  return rgb.map((v, i) => mix(v, mix(shadows[i] as number, highlights[i] as number, l), clamp01(amount))) as Vec3;
}

const GAMMA = 2.2;
/** Black and white: contrast about mid grey in display space; `hard` thresholds at 50 % display. Returns linear grey. */
export function monoValue(linearLuma: number, contrast: number, hard: boolean): number {
  let s = Math.pow(Math.max(linearLuma, 0), 1 / GAMMA);
  s = (s - 0.5) * contrast + 0.5;
  if (hard) s = s >= 0.5 ? 1 : 0;
  return Math.pow(clamp01(s), GAMMA);
}
export function mono(rgb: Vec3, amount: number, contrast: number, hard: boolean): Vec3 {
  const g = monoValue(luma(...rgb), contrast, hard);
  return rgb.map((v) => mix(v, g, clamp01(amount))) as Vec3;
}

/** Hue in degrees [0,360) of a colour (0 for greys). */
export function rgbHue(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  if (d <= 1e-9) return 0;
  let h: number;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
/** Colour pop: keep colours within `range` degrees of `hue`, fade to grey over the next half range. */
export function colorPopKeep(hueOfPixel: number, hue: number, range: number): number {
  return 1 - smoothstep(range, range * 1.5, hueDistance(hueOfPixel, hue));
}
export function colorPop(rgb: Vec3, amount: number, hue: number, range: number): Vec3 {
  const l = luma(...rgb);
  const k = colorPopKeep(rgbHue(...rgb), hue, range);
  return rgb.map((v) => mix(v, mix(l, v, k), clamp01(amount))) as Vec3;
}

/** VHS scanline gain for pixel row y. */
export function scanlineGain(y: number, periodPx: number, scan: number, amount: number): number {
  return 1 - clamp01(scan) * clamp01(amount) * 0.3 * (0.5 + 0.5 * Math.cos((2 * Math.PI * y) / periodPx));
}
/** VHS horizontal wobble offset (fraction of width) for a row band value in 0..1 and a per-row jitter in 0..1. */
export function vhsWobble(band: number, jitter: number, wobble: number, amount: number): number {
  return ((band - 0.5) * 2 * wobble * 0.012 + (jitter - 0.5) * wobble * 0.002) * amount;
}
export function vhsBucket(tMs: number): number {
  return Math.floor(tMs / 33);
}

/** Letterbox: height of each bar as a fraction of the frame height. */
export function letterboxBar(w: number, h: number, amount: number): number {
  // Tall and square frames (TikTok, Reels): a 2.39:1 strip would leave almost nothing, so the bars are 12 % each.
  if (h >= w) return clamp01(amount) * TALL_BAR;
  const picture = w / 2.39;
  return (clamp01(amount) * Math.max(0, h - picture)) / (2 * h);
}

/** Each bar's height on tall and square frames at amount 1 (fraction of the height). */
export const TALL_BAR = 0.12;

/** Light leak: blob centres (0..1) drifting with time. */
export function leakBlob(i: number, tMs: number, speed: number, seed: number): [number, number, number] {
  const ph = hash01(seed * 7 + i * 13) * 6.2831853;
  const t = (tMs / 1000) * speed;
  const x = 0.5 + 0.55 * Math.sin(t * (0.31 + 0.11 * i) + ph);
  const y = 0.5 + 0.55 * Math.cos(t * (0.23 + 0.09 * i) + ph * 1.7);
  const r = 0.28 + 0.1 * i;
  return [x, y, r];
}
export function leakIntensity(u: number, v: number, tMs: number, speed: number, seed: number): number {
  let s = 0;
  for (let i = 0; i < 3; i++) {
    const [x, y, r] = leakBlob(i, tMs, speed, seed);
    const d2 = (u - x) ** 2 + (v - y) ** 2;
    s += Math.exp(-d2 / (r * r));
  }
  return clamp01(s * 0.6);
}

/** Speed lines: the 2-frame bucket and whether a ray is lit. */
export function speedBucket(tMs: number): number {
  return Math.floor(tMs / 66);
}
export function speedlineMask(angleRad: number, rNorm: number, density: number, inner: number, bucket: number, seed: number): number {
  const a = (angleRad / (2 * Math.PI) + 1) % 1;
  const idx = Math.floor(a * density);
  const h = hash01(idx * 7 + bucket * 131 + seed * 977);
  const lit = h > 0.45 ? 1 : 0;
  const width = 0.3 + 0.7 * hash01(idx * 11 + bucket * 17 + seed * 31 + 5000003);
  const f = a * density - idx; // 0..1 within the ray
  const ray = 1 - smoothstep(width * 0.5 - 0.1, width * 0.5 + 0.1, Math.abs(f - 0.5));
  return lit * ray * smoothstep(inner, inner + 0.25, rNorm);
}

/** Sharpen: unsharp mask against the 4-neighbour mean. */
export function sharpen(c: number, neighbourMean: number, amount: number): number {
  return Math.max(0, c + amount * (c - neighbourMean));
}

/** Sobel magnitude on a 3x3 luma neighbourhood (row-major). */
export function sobel(l: readonly number[]): number {
  const g = (i: number): number => l[i] as number;
  const gx = -g(0) - 2 * g(3) - g(6) + g(2) + 2 * g(5) + g(8);
  const gy = -g(0) - 2 * g(1) - g(2) + g(6) + 2 * g(7) + g(8);
  return Math.hypot(gx, gy);
}
export function edgeStrength(mag: number): number {
  return smoothstep(0.1, 0.5, mag);
}

/** Halftone: cell geometry on a grid rotated by angleDeg; returns the cell centre (original coords) and distance to it. */
export function halftoneCell(x: number, y: number, cell: number, angleDeg: number): { cx: number; cy: number; d: number } {
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const px = c * x + s * y;
  const py = -s * x + c * y;
  const gx = (Math.floor(px / cell) + 0.5) * cell;
  const gy = (Math.floor(py / cell) + 0.5) * cell;
  return { cx: c * gx - s * gy, cy: s * gx + c * gy, d: Math.hypot(px - gx, py - gy) };
}
/** Dot radius for a display-space luma (area ~ luma; reaches the cell corner at 1). */
export function halftoneRadius(displayLuma: number, cell: number): number {
  return 0.7072 * cell * Math.sqrt(clamp01(displayLuma));
}
export function halftoneCoverage(displayLuma: number, d: number, cell: number): number {
  const r = halftoneRadius(displayLuma, cell);
  return clamp01(0.5 - (d - r)) * smoothstep(0, 0.5, r);
}
