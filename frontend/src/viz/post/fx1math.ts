/** Pure TS models of the FX1 shaders (UV mappings and weights), mirrored by the GLSL and tested without GL. */

export const TAU = Math.PI * 2;
const glmod = (x: number, y: number) => x - y * Math.floor(x / y);
const fract = (x: number) => x - Math.floor(x);

/** GLSL `1 - abs(1 - mod(x, 2))`: reflects any coordinate back into 0..1 (no borders). */
export function mirrorFold(x: number): number {
  return 1 - Math.abs(1 - glmod(x, 2));
}

export const BLUR_TAPS = 24;

/** Zoom blur: sample positions along the line to the centre; scale 1 down to 1 - amount*0.35. */
export function zoomBlurTaps(uv: [number, number], c: [number, number], amount: number, n = BLUR_TAPS): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const s = 1 - amount * 0.35 * (i / (n - 1));
    out.push([c[0] + (uv[0] - c[0]) * s, c[1] + (uv[1] - c[1]) * s]);
  }
  return out;
}

/** Directional blur: UV offsets centred on the pixel; total length amount*0.12 of the short side. */
export function dirBlurOffsets(res: [number, number], amount: number, angleDeg: number, n = BLUR_TAPS): [number, number][] {
  const len = amount * 0.12 * Math.min(res[0], res[1]);
  const a = (angleDeg * Math.PI) / 180;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1) - 0.5;
    out.push([(Math.cos(a) * len * t) / res[0], (Math.sin(a) * len * t) / res[1]]);
  }
  return out;
}

export const GLOW_LEVELS = 5;

/** Soft bright pass: the factor applied to a pixel whose brightest channel is m. */
export function glowBright(m: number, threshold: number): number {
  return m > 1e-5 ? Math.max(0, m - threshold) / m : 0;
}

/** Weights of the pyramid levels (sum 1): radius 0 favours the finest level, 1 the coarsest. */
export function glowLevelWeights(radius: number, levels = GLOW_LEVELS): number[] {
  const centre = Math.max(0, Math.min(1, radius)) * (levels - 1);
  const w: number[] = [];
  for (let i = 0; i < levels; i++) w.push(Math.exp(-0.5 * ((i - centre) / 1.1) ** 2));
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / sum);
}

/** Target sizes of the pyramid: half resolution first, each level half the previous (min 1). */
export function glowLevelSizes(w: number, h: number, levels = GLOW_LEVELS): [number, number][] {
  const out: [number, number][] = [];
  let cw = w;
  let ch = h;
  for (let i = 0; i < levels; i++) {
    cw = Math.max(1, Math.floor(cw / 2));
    ch = Math.max(1, Math.floor(ch / 2));
    out.push([cw, ch]);
  }
  return out;
}

/**
 * Perspective rotation of the frame plane around its centre. p is in short-side units centred on 0.
 * Returns the source position (same units) or null where the plane is behind the camera.
 */
export function swingMap(p: [number, number], rotXDeg: number, rotYDeg: number, persp: number): [number, number] | null {
  const a = (rotXDeg * Math.PI) / 180;
  const b = (rotYDeg * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
  const invD = persp * 0.8;
  const n: [number, number, number] = [sb, -cb * sa, cb * ca];
  const np = n[0] * p[0] + n[1] * p[1];
  const den = n[2] - invD * np;
  if (den <= 1e-4) return null;
  const t = n[2] / den;
  const X: [number, number, number] = [t * p[0], t * p[1], -np / den];
  // R^T X = Ry^T Rx^T X
  const vy = X[1] * ca + X[2] * sa;
  const vz = -X[1] * sa + X[2] * ca;
  return [X[0] * cb - vz * sb, vy];
}

export function twirlAngle(r: number, R: number, amount: number): number {
  if (R <= 0 || r >= R) return 0;
  const k = 1 - r / R;
  return amount * TAU * k * k;
}

/** Twirl: p relative to the centre (short-side units) to source position. */
export function twirlMap(p: [number, number], R: number, amount: number): [number, number] {
  const a = twirlAngle(Math.hypot(p[0], p[1]), R, amount);
  const c = Math.cos(a), s = Math.sin(a);
  return [c * p[0] - s * p[1], s * p[0] + c * p[1]];
}

/** Sine offset in UV units (up to amount*0.05). */
export function waveOffset(coord: number, amount: number, freq: number, speed: number, tSec: number): number {
  return amount * 0.05 * Math.sin(TAU * (freq * coord + speed * tSec));
}

/** Radius factor of bulge (>0 magnifies the centre) / pinch (<0). rn = r / radius. */
export function bulgeFactor(rn: number, amount: number): number {
  if (rn >= 1) return 1;
  return 1 - 0.8 * amount * (1 - rn * rn);
}

export function bulgeMap(p: [number, number], R: number, amount: number): [number, number] {
  const f = bulgeFactor(R > 0 ? Math.hypot(p[0], p[1]) / R : 1, amount);
  return [p[0] * f, p[1] * f];
}

export function shockRadius(amount: number, halfDiag: number): number {
  return (1 - amount) * 1.2 * halfDiag;
}

/** Bump 1 at the ring centre, 0 at +-w. */
export function shockRing(d: number, w: number): number {
  return Math.abs(d) < w ? (1 + Math.cos((Math.PI * d) / w)) / 2 : 0;
}

/** Radial displacement (same units as r) of the refracting ring; width is a fraction of the half-diagonal. */
export function shockDisp(r: number, amount: number, width: number, strength: number, halfDiag: number): number {
  const w = width * halfDiag;
  return 0.5 * amount * strength * w * shockRing(r - shockRadius(amount, halfDiag), w);
}

/** Folds an angle into one mirrored segment [0, 2pi/segments]. */
export function kaleidoAngle(angle: number, segments: number, rotRad: number): number {
  const seg = TAU / segments;
  const a = glmod(angle - rotRad, seg * 2);
  return a > seg ? seg * 2 - a : a;
}

export function hash21(x: number, y: number): number {
  let p0 = fract(x * 0.1031);
  let p1 = fract(y * 0.1031);
  let p2 = fract(x * 0.1031);
  const d = p0 * (p1 + 33.33) + p1 * (p2 + 33.33) + p2 * (p0 + 33.33);
  p0 += d;
  p1 += d;
  p2 += d;
  return fract((p0 + p1) * p2);
}

export const SLICE_STEP_MS = 66;
export const sliceBucket = (tMs: number) => Math.floor(tMs / SLICE_STEP_MS);

/** Horizontal shift of a band in UV units and its RGB split (UV units); changes every 66 ms bucket. */
export function sliceShift(band: number, tMs: number, seed: number, amount: number, rgb: number): { shift: number; split: number } {
  const bucket = sliceBucket(tMs);
  const sd = glmod(seed, 1000);
  const h = hash21(band + sd * 7.31, bucket);
  const h2 = hash21(band + 91.7, bucket + sd);
  return { shift: (h - 0.5) * 2 * amount * 0.25, split: (h2 - 0.5) * 2 * rgb * amount * 0.04 };
}
