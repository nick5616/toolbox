/**
 * Pure models of the Edit Studio FX transitions (SPEC §23.5). The shaders in
 * transitions.ts mirror these functions; tests prove the endpoints (mix 0 is
 * exactly the outgoing picture, mix 1 exactly the incoming one) and that
 * reveals only grow. No clocks, no Math.random.
 */
import { clamp01, hash01 } from "./post/px1math";

export const smooth = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

/** Peaks at 1 at mix 0.5 and vanishes at both ends. */
export const envelope = (mix: number): number => Math.sin(Math.PI * clamp01(mix));

/** Triangle: 0 at both ends, 1 at 0.5. */
export const triangle = (mix: number): number => {
  const m = clamp01(mix);
  return m < 0.5 ? 2 * m : 2 - 2 * m;
};

/** 0 = show the outgoing picture, 1 = the incoming one (a step at 0.5). */
export const swap = (mix: number): 0 | 1 => (clamp01(mix) < 0.5 ? 0 : 1);

/** Zoom-out: scale applied to the outgoing sampling coordinate (1 at mix 0). */
export const zoomOutScaleA = (mix: number): number => 1 + 0.5 * smooth(mix);
/** Zoom-out: how magnified the incoming picture is (1.3 to 1; exactly 1 at mix 1). */
export const zoomOutScaleB = (mix: number): number => 1.3 - 0.3 * smooth(mix);
/** Zoom-out: weight of the incoming picture. */
export const zoomOutWeight = (mix: number): number => smooth((clamp01(mix) - 0.2) / 0.6);
/** Zoom-out: radial blur length (fraction of the radius). */
export const zoomOutBlur = (mix: number): number => 0.18 * envelope(mix);

/** Spin: rotation of whichever side is showing. a: 0 to 90 degrees, b: -90 to 0 degrees. */
export const spinAngle = (mix: number): number => {
  const m = clamp01(mix);
  const a = Math.PI * smooth(m);
  return m < 0.5 ? a : a - Math.PI;
};
export const spinBlur = (mix: number): number => 0.3 * envelope(mix);

/** Whip: horizontal shift (uv) of the showing side; zero at the ends. */
export const whipShift = (mix: number): number => {
  const m = clamp01(mix);
  if (m < 0.5) return 0.6 * (2 * m) ** 2;
  return 0 - 0.6 * (2 * (1 - m)) ** 2;
};
export const whipBlur = (mix: number): number => 0.14 * envelope(mix);

/** Slide: how far (in widths) the pair has moved left. */
export const slideOffset = (mix: number): number => smooth(mix);
/** Which picture covers column x (0..1) and at which source x. */
export function slideSample(x: number, mix: number): { from: 0 | 1; x: number } {
  const t = x + slideOffset(mix);
  return t < 1 ? { from: 0, x: t } : { from: 1, x: t - 1 };
}

/** Blur: disc radius (uv, short side) of the showing side. */
export const blurRadius = (mix: number): number => 0.05 * triangle(mix);

/** RGB split: channel offset (uv x). */
export const rgbSplitOffset = (mix: number): number => 0.03 * envelope(mix);

/** Shake: deterministic jitter (uv) that changes every 33 ms of song time. */
export function shakeOffset(tMs: number, mix: number): [number, number] {
  const k = Math.floor(tMs / 33);
  const e = 0.12 * envelope(mix);
  return [(hash01(k * 2 + 1) - 0.5) * e, (hash01(k * 2 + 2) - 0.5) * e];
}

/** Warp: twirl strength (0 at both ends, 1 at the swap). */
export const warpAmount = (mix: number): number => smooth(triangle(mix));
export const WARP_ANGLE = 6;

/** Luma: soft edge width, and the weight of b for a pixel of outgoing luma l (0..1). */
export const LUMA_EDGE = 0.08;
export function lumaReveal(l: number, mix: number): number {
  const t = clamp01(mix) * (1 + 2 * LUMA_EDGE) - LUMA_EDGE;
  const lc = clamp01(l);
  return smooth((t - (lc - LUMA_EDGE)) / (2 * LUMA_EDGE));
}

/** A reveal edge: 1 inside distance r, 0 beyond, a soft fall in between. */
export function revealEdge(d: number, r: number, soft: number): number {
  return 1 - smooth((d - (r - soft)) / soft);
}

export const IRIS_SOFT = 0.02;
/** Distance from the centre to a corner, in short-side units. */
export const irisMaxRadius = (aspect: number): number => 0.5 * Math.hypot(aspect, 1);
/** Weight of b at distance d (short-side units) from the centre. */
export const irisReveal = (d: number, mix: number, aspect: number): number =>
  revealEdge(d, clamp01(mix) * (irisMaxRadius(aspect) + IRIS_SOFT), IRIS_SOFT);

export const STRIPE_COUNT = 10;
export const STRIPE_SOFT = 0.04;
/** Weight of b at a position (uv) for diagonal stripes; odd stripes run the other way. */
export function stripesReveal(x: number, y: number, aspect: number, mix: number): number {
  const s = (x * aspect + y) * STRIPE_COUNT;
  const i = Math.floor(s);
  let f = s - i;
  if (i % 2 !== 0) f = 1 - f;
  return revealEdge(f, clamp01(mix) * (1 + STRIPE_SOFT), STRIPE_SOFT);
}

/** Flash to black: gains for a and b. */
export const flashBlackGainA = (mix: number): number => 1 - smooth(2 * clamp01(mix));
export const flashBlackGainB = (mix: number): number => smooth(2 * clamp01(mix) - 1);
