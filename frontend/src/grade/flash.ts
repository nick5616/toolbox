/**
 * Flash safety measurement (Phase 21 SPEC §E3.4). `viz/lab/motion.ts` (V2) has the app-wide motion metric;
 * Color Grader needs a WCAG-style counter now, for the look tests, so this is a small self-contained one:
 *
 * - `simulateMeanLuma` runs a recipe's compiled colour chain on a fixed set of test colours with the CPU
 *   reference (grade/math.ts), frame by frame, with a synthetic beat track, and returns the mean relative
 *   luminance (0..1) per frame; spatial passes that pulse (glow, halation, …) add their estimated luminance
 *   (compile.ts's impact table × amount × pulse);
 * - `flashesPerSec` counts WCAG 2.x general flashes: a pair of opposing changes in relative luminance of at
 *   least 10% of the full range; it returns the maximum in any one-second window (conservative: the "darker
 *   image under 0.8" condition isn't applied).
 */
import { compileRecipe, BEAT_ATTACK_MS, BEAT_RELEASE_MS } from "./compile";
import { evalRows, pulseOf, defaultPixel, toLin, type Vec3 } from "./math";
import { packTable, parseTable, ROW_FLOATS } from "./pack";
import type { GradeAuxState, GradeRecipe } from "./types";
import type { EditParam } from "@/viz/edit/types";

/** Test colours: a grey ramp, the primaries and secondaries, skin, sky, foliage. sRGB 0..1. */
export const TEST_COLORS: Vec3[] = [
  [0.05, 0.05, 0.05], [0.25, 0.25, 0.25], [0.5, 0.5, 0.5], [0.75, 0.75, 0.75], [0.95, 0.95, 0.95],
  [0.9, 0.1, 0.1], [0.1, 0.8, 0.2], [0.1, 0.2, 0.9], [0.9, 0.85, 0.1], [0.1, 0.8, 0.8], [0.85, 0.15, 0.8],
  [0.85, 0.62, 0.5], [0.45, 0.65, 0.9], [0.2, 0.45, 0.15], [0.35, 0.25, 0.2], [0.7, 0.65, 0.55],
];

/** The relative luminance (linear) of an sRGB colour. */
export const relLuma = (c: Vec3): number => 0.2126 * toLin(c[0]) + 0.7152 * toLin(c[1]) + 0.0722 * toLin(c[2]);

/** One beat's pulse: rises over the attack, falls over the release. */
const pulseShape = (dt: number): number => (dt < 0 ? 0 : dt < BEAT_ATTACK_MS ? dt / BEAT_ATTACK_MS : Math.max(0, 1 - (dt - BEAT_ATTACK_MS) / BEAT_RELEASE_MS));

/** A beat envelope: each beat's pulse, the highest of the recent ones (a new beat never pulls the level down). */
export function beatEnv(tMs: number, periodMs: number): number {
  const dt = tMs % periodMs;
  let v = 0;
  for (let k = 0; k < 3; k++) v = Math.max(v, pulseShape(dt + k * periodMs));
  return v;
}

export interface SimOptions {
  seconds?: number;
  fps?: number;
  /** Beats per minute of the synthetic track (default 180, the fastest we expect). A bar is 4 beats. */
  bpm?: number;
}

const ALL_AUX: GradeAuxState = { depth: true, subject: true, people: true };

/** How much a full-amount spatial pass moves the mean luminance (mirrors compile.ts). */
const SPATIAL_IMPACT: Record<string, number> = { glow: 0.25, halation: 0.12, edgeglow: 0.1, depthfog: 0.35, tiltshift: 0.02 };

export function simulateMeanLuma(recipe: GradeRecipe, wild: number, opts: SimOptions = {}): number[] {
  const seconds = opts.seconds ?? 10;
  const fps = opts.fps ?? 30;
  const beatMs = 60000 / (opts.bpm ?? 180);
  const posts = compileRecipe(recipe, wild, ALL_AUX);
  const frames = Math.round(seconds * fps);
  const out: number[] = [];
  // Static recipes don't need a time loop.
  const animated = posts.some((p) => typeof p.params.table === "string" && /"wave":"(sine|saw|ext)"/.test(p.params.table as string));
  const n = animated ? frames : 1;
  const tables = posts.map((p) => (typeof p.params.table === "string" ? packTable(parseTable(p.params.table)) : null));
  for (let f = 0; f < n; f++) {
    const tMs = (f * 1000) / fps;
    const driveOf = (p: (typeof posts)[number]): number[] => {
      const d = new Array<number>(16).fill(1);
      for (let i = 0; i < 16; i++) {
        const v = p.params[`d${i}`] as EditParam | undefined;
        if (v && typeof v === "object" && v.mods?.length) {
          const sig = v.mods[0]?.signal ?? "beat.pulse";
          d[i] = beatEnv(tMs, sig === "bar.pulse" ? beatMs * 4 : beatMs);
        }
      }
      return d;
    };
    let sum = 0;
    let count = 0;
    for (const [ci, c] of TEST_COLORS.entries()) for (let rep = 0; rep < 4; rep++) {
      count++;
      let cur = c;
      for (let pi = 0; pi < posts.length; pi++) {
        const p = posts[pi]!;
        const t = tables[pi];
        if (p.type === "gradelook" && t && !p.params.restore && !p.params.stash) {
          cur = evalRows(t.data, t.count, cur, defaultPixel({ t: tMs / 1000, drive: driveOf(p), x: ((ci * 5 + rep * 3 + 0.5) % 16) / 16, y: ((ci * 3 + rep * 7 + 0.5) % 16) / 16, w: 64, h: 64 }));
        }
      }
      sum += relLuma(cur);
    }
    let mean = sum / count;
    // Pulsing spatial passes: the gate that follows them carries the pulse.
    for (let pi = 0; pi < posts.length; pi++) {
      const p = posts[pi]!;
      const t = tables[pi];
      if (p.type !== "gradelook" || !p.params.restore || !t || t.count === 0) continue;
      const spatial = posts[pi - 1];
      if (!spatial) continue;
      const row = t.data.subarray(0, ROW_FLOATS);
      const pulse = pulseOf(row, 0, defaultPixel({ t: tMs / 1000, drive: driveOf(p) }), 0);
      const amount = typeof spatial.params.amount === "number" ? Math.min(1, spatial.params.amount) : 0.5;
      mean += (SPATIAL_IMPACT[spatial.type] ?? 0.08) * amount * pulse * (spatial.type === "depthfog" ? -1 : 1);
    }
    out.push(mean);
  }
  while (out.length < frames) out.push(out[0] ?? 0);
  return out;
}

/** The most WCAG general flashes in any one-second window of a luminance series (0..1 per frame). */
export function flashesPerSec(series: readonly number[], fps: number, threshold = 0.1): number {
  // Swings of at least `threshold` between turning points (hysteresis), with their frame.
  const swings: number[] = [];
  if (series.length < 2) return 0;
  let dir = 0;
  let ext = series[0] as number;
  let extAt = 0;
  for (let i = 1; i < series.length; i++) {
    const v = series[i] as number;
    if (dir >= 0 && v > ext) {
      ext = v;
      extAt = i;
      if (dir === 0 && v - (series[0] as number) >= threshold) dir = 1;
    } else if (dir <= 0 && v < ext) {
      ext = v;
      extAt = i;
      if (dir === 0 && (series[0] as number) - v >= threshold) dir = -1;
    }
    if (dir === 1 && ext - v >= threshold) {
      swings.push(extAt);
      dir = -1;
      ext = v;
      extAt = i;
    } else if (dir === -1 && v - ext >= threshold) {
      swings.push(extAt);
      dir = 1;
      ext = v;
      extAt = i;
    }
  }
  // A flash is a pair of opposing swings.
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < swings.length; hi++) {
    while ((swings[hi] as number) - (swings[lo] as number) >= fps) lo++;
    best = Math.max(best, (hi - lo + 1) / 2);
  }
  return best;
}

/** Convenience for tests and the UI: the worst flash rate of a recipe at a wildness (synthetic 180 bpm track). */
export function recipeFlashes(recipe: GradeRecipe, wild: number, opts: SimOptions = {}): number {
  const fps = opts.fps ?? 30;
  return flashesPerSec(simulateMeanLuma(recipe, wild, opts), fps);
}
