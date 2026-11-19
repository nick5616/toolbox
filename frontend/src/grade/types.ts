/**
 * Color Grader recipes (Phase 21 SPEC §E2). FROZEN after Wave 0. Mirrored by
 * modules/grade/recipe.go; both validate the shared vectors in
 * core/testdata/grade-recipes.json. `src/grade/` is engine-level (like
 * `composer/`): it never imports a tool.
 */

export const RECIPE_VERSION = 1;
export const MAX_OPS = 16;
export const MAX_NAME = 40;
/** Ops marked `chaos` are active only above this Wildness. */
export const CHAOS_ABOVE = 0.66;

export type GradeTier = "film" | "bold" | "bonkers" | "mine" | "ai";
export type WildCurve = "linear" | "late" | "early";

export const GRADE_OP_KINDS = [
  // colour-only (one `gradelook` pass, LUT-able)
  "balance", "wheels", "curves", "hsl", "split", "gradmap", "chanmix", "solarize", "posterize", "invert", "huecycle", "transfer", "bleach",
  // spatial (their own passes)
  "glow", "halation", "edgeglow", "depthfog", "tiltshift", "grain", "vignette", "chromatic", "halftone", "glitch", "vhs", "sharpen", "mirror",
] as const;
export type GradeOpKind = (typeof GRADE_OP_KINDS)[number];

export type GradeParam = number | string | boolean | number[];

export type Region =
  | { kind: "all" }
  | { kind: "highlights" | "shadows" | "midtones"; soft: number }
  | { kind: "subject" | "background" | "people"; feather: number; invert?: boolean }
  | { kind: "near" | "far"; split: number; feather: number };

export interface GradeAnim {
  /** Cycles per 10 s (0.05..6). */
  speed: number;
  wave: "sine" | "saw" | "beat" | "bar";
}

export interface GradeOp {
  /** 6 chars, unique in the recipe. */
  id: string;
  kind: GradeOpKind;
  on: boolean;
  /** Active only at Wildness > CHAOS_ABOVE. */
  chaos?: boolean;
  /** Strength at Wildness 1 (0..1). */
  amount: number;
  region: Region;
  params: Record<string, GradeParam>;
  /** Video only. */
  anim?: GradeAnim;
}

export interface GradeRecipe {
  v: 1;
  name: string;
  tier: GradeTier;
  seed: number; // u32
  wildCurve: WildCurve;
  ops: GradeOp[];
}

/** A built-in look: a recipe with a stable id (for steps and saved state). */
export interface BuiltInLook {
  id: string; // kebab-case, e.g. "neon-noir"
  recipe: GradeRecipe;
  /** One line for the gallery tooltip. */
  blurb: string;
}

/** One op kind's catalog entry (ops.ts). */
export interface OpParamSpec {
  kind: "number" | "color" | "enum" | "bool" | "points" | "stops" | "matrix";
  label: string;
  min?: number;
  max?: number;
  options?: readonly string[];
  default: GradeParam;
}

export interface OpDef {
  kind: GradeOpKind;
  label: string;
  /** One line: what it does. Shown in the Look rail and given to the chat model. */
  effect: string;
  /** Colour-only ops run in the single `gradelook` pass and can go in a LUT. */
  colorOnly: boolean;
  animatable: boolean;
  /** Region maps the op itself needs (depthfog, tiltshift: depth). */
  needs?: Array<"depth" | "subject" | "people">;
  params: Record<string, OpParamSpec>;
}

/** The maps available for the current input (from GradeService.Maps). */
export interface GradeAuxState {
  depth: boolean;
  subject: boolean;
  people: boolean;
}
