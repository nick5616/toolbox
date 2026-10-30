/**
 * Pure helpers behind the PX1 post effects and transitions (no GL, so they
 * are unit-tested). Everything is a function of its arguments only.
 */

export const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Integer hash to 0..1 (deterministic; same on every machine). */
export function hash01(n: number): number {
  let h = (Math.imul(Math.floor(n) | 0, 0x9e3779b1) ^ 0x85ebca6b) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Smooth 1-D value noise in -1..1 at x. */
export function noise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash01(i * 7 + seed * 131) * 2 - 1;
  const b = hash01((i + 1) * 7 + seed * 131) * 2 - 1;
  return a + (b - a) * u;
}

/** The hardest the camera may move: 2% of the short side. */
export const SHAKE_MAX_FRACTION = 0.02;

/**
 * Camera shake offset in pixels. Direction jitters at ~24 Hz with smooth
 * noise; magnitude follows the kick. Each axis is bounded by amount·2% of the
 * short side (amount 0..1).
 */
export function shakeOffset(tMs: number, seed: number, kick: number, shortSide: number, amount: number): [number, number] {
  const a = Math.max(0, Math.min(1, amount));
  const k = clamp01(kick);
  const mag = a * k * SHAKE_MAX_FRACTION * shortSide;
  const t = tMs / 1000;
  return [noise1(t * 24, seed) * mag, noise1(t * 24 + 91.7, seed + 17) * mag];
}

/** Scale (>1 = zoom in) that hides the borders exposed by an offset in pixels. */
export function shakeCover(ox: number, oy: number, w: number, h: number): number {
  return 1 + 2 * Math.max(Math.abs(ox) / w, Math.abs(oy) / h);
}

/** Zoom factor for the beat pulse (1 = none). Max extra scale is 6% × amount. */
export function zoomPulseScale(pulse: number, amount: number): number {
  return 1 + 0.06 * Math.max(0, Math.min(1, amount)) * clamp01(pulse);
}

/**
 * Chromatic aberration radius in pixels at the frame edge for a 720-line
 * frame, scaled to the real short side: a quiet base plus the driving signal.
 */
export function chromaticPx(amountPx: number, drive: number, shortSide: number): number {
  return amountPx * (0.25 + 0.75 * clamp01(drive)) * (shortSide / 720);
}

/** Per-frame decay made independent of the frame rate (reference 60 fps). */
export function frameDecay(decayPer60: number, dtMs: number): number {
  const dt = Math.max(1, Math.min(100, dtMs || 1000 / 60));
  return Math.pow(Math.max(0, Math.min(0.999, decayPer60)), dt / (1000 / 60));
}

/** Folds an angle into one mirrored wedge of a kaleidoscope with n segments. */
export function foldAngle(angle: number, segments: number): number {
  const seg = (Math.PI * 2) / Math.max(2, Math.round(segments));
  let a = angle % (seg * 2);
  if (a < 0) a += seg * 2;
  return a > seg ? seg * 2 - a : a;
}

/** Glitch activity: silent below 0.08, then ramps to 1 on a strong drop. */
export function glitchStrength(drop: number, amount: number): number {
  const x = clamp01((drop - 0.08) / 0.5);
  return x * x * (3 - 2 * x) * clamp01(amount);
}

/** Time step (30 per second) the glitch blocks are frozen to. */
export function glitchStep(tMs: number): number {
  return Math.floor((tMs / 1000) * 30);
}

/** Transition glitch envelope: a quick bell that peaks at mix 0.5. */
export function glitchBell(mix: number): number {
  const x = 1 - Math.abs(clamp01(mix) * 2 - 1);
  return x * x * (3 - 2 * x);
}

/** White level added by the flash transition. */
export function flashLevel(mix: number): number {
  const m = clamp01(mix);
  return Math.pow(1 - m, 2.5) * 1.6;
}

/** x position (uv) of the sweep band centre; starts and ends fully off screen. */
export function sweepCentre(mix: number, halfWidth: number): number {
  return -halfWidth + clamp01(mix) * (1 + 2 * halfWidth);
}
