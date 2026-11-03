/**
 * Pure helpers behind the ES5 post passes (punch, flash, blur pulse, exposure,
 * invert) and the additive `trigger` params (no GL, so they are unit-tested).
 */
import { clamp01 } from "./px1math";

/**
 * The driver of a pulse-style effect. "amount" replaces the hard-wired signal
 * with 1, so the Amount param (with its reactions and mods) is the whole
 * strength. Anything else (including an old design without the param) keeps
 * the original signal. The signal is read lazily so "amount" costs nothing.
 */
export function triggerDrive(trigger: unknown, signal: () => number): number {
  return trigger === "amount" ? 1 : signal();
}

/** Radial blur reach of the zoom punch: 2% of the short side at full strength. */
export const PUNCH_BLUR_FRACTION = 0.02;

export interface PunchTransform {
  /** Total scale applied to the picture (zoom times cover), >= 1. */
  scale: number;
  /** Rotation in radians. */
  angle: number;
  /** Radial blur reach in pixels at the frame edge. */
  blurPx: number;
}

/** Scale (>= 1) that keeps a w x h frame rotated by `angle` radians covering the view. */
export function rotationCover(angle: number, w: number, h: number): number {
  const a = Math.abs(angle);
  const r = Math.max(w / h, h / w);
  return Math.cos(a) + Math.sin(a) * r;
}

export function punchTransform(amount: number, zoom: number, rotateDeg: number, blur: number, w: number, h: number): PunchTransform {
  const a = clamp01(amount);
  const angle = (rotateDeg * a * Math.PI) / 180;
  const scale = (1 + zoom * a) * rotationCover(angle, w, h);
  return { scale, angle, blurPx: blur * a * PUNCH_BLUR_FRACTION * Math.min(w, h) };
}

/** Colour level added (or screened) by the flash: amount * 1.6. */
export function flashGain(amount: number): number {
  return clamp01(amount) * 1.6;
}

/** Alpha after a flash: max(a, amount). */
export function flashAlpha(alpha: number, amount: number): number {
  return Math.max(alpha, clamp01(amount));
}

/** Per-channel flash result for premultiplied rgb `c` and flash colour `col`. */
export function flashChannel(c: number, col: number, amount: number, mode: string): number {
  const add = col * flashGain(amount);
  if (mode === "screen") {
    const s = Math.min(1, add);
    return c + s - c * s;
  }
  return c + add;
}

/** Gaussian sigma in pixels for the blur pulse. */
export function blurSigmaPx(radius: number, amount: number, shortSide: number): number {
  return Math.max(0, radius) * clamp01(amount) * shortSide;
}

/** Pixel spacing of the 8 taps per side so they span ~3 sigma (never below 1 px). */
export function blurStepPx(sigma: number): number {
  return Math.max(1, (sigma * 3) / 8);
}

/** Normalised Gaussian weights for taps 0..n (tap 0 counted once, the rest twice). */
export function gaussWeights(sigma: number, step: number, n: number): number[] {
  const w: number[] = [];
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    const d = i * step;
    const v = sigma > 0 ? Math.exp(-(d * d) / (2 * sigma * sigma)) : i === 0 ? 1 : 0;
    w.push(v);
    sum += i === 0 ? v : 2 * v;
  }
  return w.map((v) => v / sum);
}

/** Linear gain of the exposure pulse: 2^(stops * amount), amount -1..1. */
export function exposureGain(amount: number, stops: number): number {
  return Math.pow(2, stops * Math.max(-1, Math.min(1, amount)));
}

/** Premultiplied invert of one channel: mix(c, a - c, amount). */
export function invertChannel(c: number, alpha: number, amount: number): number {
  const m = clamp01(amount);
  return c + (alpha - c - c) * m;
}
