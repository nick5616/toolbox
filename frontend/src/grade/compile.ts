/**
 * compileRecipe (Phase 21 SPEC §E3.2): a look at a Wildness → the editor effects that draw it. Pure and
 * golden-tested; the Color Grader preview, its exports (the render host compiles plan.grade with it), the
 * pipeline step and the Video Editor's Looks menu all use it.
 *
 * Output, in recipe order:
 * - runs of consecutive colour-only ops (and grain/vignette, which run in the same pass but can't go in a LUT)
 *   become ONE `gradelook` post each (viz/post/gradelook.ts; its `table` param carries the compiled ops);
 * - every spatial op is its own pass (halation, edgeglow, depthfog, tiltshift, or the existing glow, chromatic,
 *   halftone, glitch, vhs, sharpen, mirror with mapped params). A spatial op with a region other than "all", or
 *   with a pulse, is wrapped in a gate: `gradelook{stash}` before it and `gradelook{restore}` after it mix the
 *   untouched copy back by region × pulse, so no pass needs a region of its own.
 *
 * Wildness: `gain(wild)` = 0.2 + 0.8 × curve(wild) scales every op's amount (curve per recipe.wildCurve: linear
 * w, late w², early 1 − (1 − w)²). Ops marked `chaos` are off at wild <= 0.66 and ramp in above it. Ops whose
 * region needs a map that isn't available are still emitted (the engine supplies constants), except that
 * `people` falls back to `subject` when only that exists, and depthfog/tiltshift are left out without depth.
 *
 * Animation (video): sine/saw pulses and drifts are computed from the frame time inside the pass; beat/bar
 * pulses are the numeric params d<i> of the gradelook post (EditParam with a `beat.pulse`/`bar.pulse` mod,
 * 120 ms attack, 300 ms release; without an analysis they read 0). Flash safety (§E3.4) is applied here: see
 * `flashSafe`.
 */
import { isGradeLookKind, OP_DEFS, opParams } from "./ops";
import { TABLE_OPS, type GradeTable, type TableAnim, type TableOp, type TableWave } from "./pack";
import { CHAOS_ABOVE, type GradeAuxState, type GradeOp, type GradeOpKind, type GradeParam, type GradeRecipe, type Region, type WildCurve } from "./types";
import type { EditMod, EditParam, EditPost } from "@/viz/edit/types";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** The wildness curve (0..1 → 0..1). */
export function wildCurve(curve: WildCurve, w: number): number {
  const x = clamp01(w);
  if (curve === "late") return x * x;
  if (curve === "early") return 1 - (1 - x) * (1 - x);
  return x;
}

/** How much of an op's authored amount shows at a wildness (0.2 at Tasteful, 1 at Bonkers). */
export function wildGain(curve: WildCurve, w: number): number {
  return 0.2 + 0.8 * wildCurve(curve, w);
}

/** The op's effective amount at a wildness (0 when it's off, or a chaos op below the threshold). */
export function opAmount(op: GradeOp, wild: number, curve: WildCurve): number {
  if (!op.on) return 0;
  const w = clamp01(wild);
  let a = op.amount * wildGain(curve, w);
  if (op.chaos) {
    if (w <= CHAOS_ABOVE) return 0;
    a *= 0.3 + 0.7 * ((w - CHAOS_ABOVE) / (1 - CHAOS_ABOVE));
  }
  return clamp01(a);
}

// ---- flash safety (§E3.4) ----

/** Roughly how far a full-amount op moves the picture's mean luminance (0..1). */
const LUMA_IMPACT: Partial<Record<GradeOpKind, number>> = {
  balance: 0.3, split: 0.12, gradmap: 0.25, solarize: 0.5, bleach: 0.2, huecycle: 0.05, glow: 0.25, halation: 0.12,
  edgeglow: 0.1, depthfog: 0.35, tiltshift: 0.02, grain: 0.04, vignette: 0.3,
};

/** Beat pulses can come three times a second; a bar at most once. */
const BEAT_PER_SEC = 3;
/** A swing above this (mean luminance) is only allowed at <= 1.5 cycles/s. */
export const FLASH_SWING = 0.1;
export const FLASH_MAX_HZ = 1.5;
export const BEAT_ATTACK_MS = 120;
export const BEAT_RELEASE_MS = 300;

/**
 * Makes an op's animation flash-safe: returns the pulse `depth` (the share of its amount the wave takes away)
 * and the (possibly lowered) speed. An animation may swing mean luminance by more than 10% only at <= 1.5
 * cycles/s; beat waves are assumed to run up to 3/s, so their swing is capped at 10%; bars may swing fully.
 */
export function flashSafe(kind: GradeOpKind, amount: number, wave: "sine" | "saw" | "beat" | "bar", speed: number): { depth: number; speed: number } {
  const swing = amount * (LUMA_IMPACT[kind] ?? 0.2);
  const hz = wave === "beat" ? BEAT_PER_SEC : wave === "bar" ? 1 : speed / 10;
  let depth = 1;
  let sp = speed;
  if (swing > FLASH_SWING) {
    if (hz > FLASH_MAX_HZ) {
      if (wave === "sine" || wave === "saw") sp = Math.min(speed, FLASH_MAX_HZ * 10);
      else depth = FLASH_SWING / swing;
    }
  }
  if (wave === "beat" || wave === "bar") depth = Math.min(depth, 0.7); // without an analysis the pulse reads 0: never fully off
  return { depth, speed: Math.max(0.05, Math.min(6, sp)) };
}

// ---- helpers ----

const paramsOf = opParams;

const num = (v: GradeParam | undefined, d: number): number => (typeof v === "number" ? v : d);
const str = (v: GradeParam | undefined, d: string): string => (typeof v === "string" ? v : d);

function beatParam(wave: "beat" | "bar"): EditParam {
  const mod: EditMod = { signal: wave === "beat" ? "beat.pulse" : "bar.pulse", amount: 1, shape: "linear", attackMs: BEAT_ATTACK_MS, releaseMs: BEAT_RELEASE_MS };
  return { base: 0, mods: [mod] };
}

interface Anim {
  table: TableAnim;
  /** For a beat/bar wave: the EditParam of the drive. */
  drive?: EditParam;
}

/** The compiled animation of an op (undefined when it has none or the kind can't animate). */
function animOf(op: GradeOp, amount: number, beatScale: number): Anim | undefined {
  const a = op.anim;
  if (!a || !OP_DEFS[op.kind].animatable) return undefined;
  const safe = flashSafe(op.kind, amount, a.wave, a.speed);
  if (a.wave === "beat" || a.wave === "bar") return { table: { wave: "ext", speed: safe.speed, depth: a.wave === "beat" ? safe.depth * beatScale : safe.depth }, drive: beatParam(a.wave) };
  return { table: { wave: a.wave as TableWave, speed: safe.speed, depth: safe.depth } };
}

/** All the beat-driven pulses of a look share this much mean-luminance swing (they can all hit on the same beat). */
export const BEAT_SWING_BUDGET = 0.07;

/** 1, or the factor that brings the summed swing of the look's beat pulses under the budget. */
function beatBudgetScale(recipe: GradeRecipe, wild: number, aux: GradeAuxState): number {
  let total = 0;
  for (const op of recipe.ops) {
    if (op.anim?.wave !== "beat" || !OP_DEFS[op.kind].animatable) continue;
    const amount = opAmount(op, wild, recipe.wildCurve);
    if (amount < MIN_AMOUNT || (OP_DEFS[op.kind].needs?.includes("depth") && !aux.depth)) continue;
    total += amount * (LUMA_IMPACT[op.kind] ?? 0.2) * flashSafe(op.kind, amount, "beat", op.anim.speed).depth;
  }
  return total > BEAT_SWING_BUDGET ? BEAT_SWING_BUDGET / total : 1;
}

/** The region as compiled: `people` falls back to `subject` when only that map exists. */
function regionOf(r: Region, aux: GradeAuxState): Region {
  if (r.kind === "people" && !aux.people && aux.subject) return { ...r, kind: "subject" };
  return r;
}

/** The pass params of a spatial op at an effective amount. */
function spatialParams(op: GradeOp, a: number): { type: EditPost["type"]; params: EditPost["params"] } | null {
  const p = paramsOf(op);
  switch (op.kind) {
    case "glow":
      return { type: "glow", params: { amount: Math.min(3, num(p.gain, 1) * a * 1.0), threshold: num(p.threshold, 0.6), radius: num(p.radius, 0.5), tint: str(p.tint, "#ffffff") } };
    case "halation":
      return { type: "halation", params: { amount: a, threshold: num(p.threshold, 0.55), radius: num(p.radius, 0.5), tint: str(p.tint, "#ff5a2a") } };
    case "edgeglow":
      return { type: "edgeglow", params: { amount: a, color: str(p.color, "#ff2bd6"), thickness: num(p.thickness, 1.5), strength: num(p.strength, 1) } };
    case "depthfog":
      return { type: "depthfog", params: { amount: a, color: str(p.color, "#ff9ed8"), start: num(p.start, 0.4), density: num(p.density, 0.6) } };
    case "tiltshift":
      return { type: "tiltshift", params: { amount: a, focus: num(p.focus, 0.6), range: num(p.range, 0.15), blur: num(p.blur, 0.5) } };
    case "chromatic":
      return { type: "chromatic", params: { amount: Math.min(24, num(p.px, 6) * a), source: "amount" } };
    case "halftone":
      return { type: "halftone", params: { amount: a, dots: num(p.dots, 90), angle: num(p.angle, 45), mode: str(p.mode, "color") } };
    case "glitch":
      return { type: "glitch", params: { amount: a, trigger: "amount" } };
    case "vhs":
      return { type: "vhs", params: { amount: a, scanlines: num(p.scanlines, 0.5), bleed: num(p.bleed, 0.5), wobble: num(p.wobble, 0.3), noise: num(p.noise, 0.3) } };
    case "sharpen":
      return { type: "sharpen", params: { amount: Math.min(2, num(p.gain, 1) * a) } };
    case "mirror":
      return { type: "mirror", params: { segments: Math.round(num(p.segments, 6)), spin: num(p.spin, 0.15), zoom: num(p.zoom, 1), mix: a } };
    default:
      return null;
  }
}

const post = (id: string, type: EditPost["type"], params: EditPost["params"]): EditPost => ({ id, type, enabled: true, params });

/** Tiny amounts do nothing visible; they're left out to keep stacks short. */
const MIN_AMOUNT = 0.002;

/** One gradelook post for a run of table ops (drives for beat/bar pulses by op index). */
function lookPost(id: string, ops: TableOp[], drives: Array<EditParam | undefined>): EditPost {
  const table: GradeTable = { ops };
  const params: EditPost["params"] = { table: JSON.stringify(table) };
  drives.forEach((d, i) => {
    if (d !== undefined) params[`d${i}`] = d;
  });
  return post(id, "gradelook", params);
}

/**
 * Compiles a recipe at a wildness into the clip's effects. Deterministic: the same inputs give the same JSON.
 * `aux` says which maps exist for the input (see the notes above).
 */
export function compileRecipe(recipe: GradeRecipe, wild: number, aux: GradeAuxState): EditPost[] {
  const beatScale = beatBudgetScale(recipe, wild, aux);
  const out: EditPost[] = [];
  let run: TableOp[] = [];
  let drives: Array<EditParam | undefined> = [];
  let runs = 0;
  const flush = () => {
    if (run.length > 0) out.push(lookPost(`look${++runs}`, run, drives));
    run = [];
    drives = [];
  };

  for (const op of recipe.ops) {
    const def = OP_DEFS[op.kind];
    if (!def) continue;
    const amount = opAmount(op, wild, recipe.wildCurve);
    if (amount < MIN_AMOUNT) continue;
    if (def.needs?.includes("depth") && !aux.depth) continue;
    const region = regionOf(op.region, aux);
    const anim = animOf(op, amount, beatScale);

    if (isGradeLookKind(op.kind)) {
      if (run.length >= TABLE_OPS) flush();
      run.push({ kind: op.kind as TableOp["kind"], amount, region, anim: anim?.table, params: paramsOf(op) });
      drives.push(anim?.drive);
      continue;
    }

    flush();
    const sp = spatialParams(op, amount);
    if (!sp) continue;
    const gated = region.kind !== "all" || anim !== undefined;
    if (!gated) {
      out.push(post(op.id, sp.type, sp.params));
      continue;
    }
    const key = `g${op.id}`;
    out.push(post(`${op.id}s`, "gradelook", { stash: key }));
    out.push(post(op.id, sp.type, sp.params));
    const gate: TableOp = { kind: "gate", amount: 1, region, anim: anim?.table, params: {} };
    const restore = lookPost(`${op.id}r`, [gate], [anim?.drive]);
    out.push({ ...restore, params: { ...restore.params, restore: key } });
  }
  flush();
  return out;
}
