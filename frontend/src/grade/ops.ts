/**
 * The op catalog (Phase 21 SPEC §E3.1): every kind's label, one-line effect, params with ranges and
 * defaults. The chat model's prompt is built from the same catalog (modules/grade/ops.go mirrors the
 * ranges; the shared vectors keep both clamping the same way).
 *
 * Param conventions (the clamp rules in validate.ts):
 * - number: clamped to [min, max];
 * - color: "#rrggbb" (anything else falls back to the default);
 * - enum: one of `options`;
 * - bool: boolean;
 * - points / matrix: a number array of exactly the default's length, each element clamped to [min, max];
 *   `curves` points are the curve's y at x = 0, .25, .5, .75, 1 (monotone cubic through them);
 *   `hsl` has three arrays of 6 (red, yellow, green, cyan, blue, magenta);
 *   `chanmix` is a 12 matrix: three output rows of (r, g, b) weights, then the three biases;
 *   `transfer.stats` is 18 numbers (Lab mean L, a, b then standard deviation L, a, b for the shadows,
 *   mids and highlights bands), as GradeService.Transfer returns them;
 * - stops: "#rrggbb@0.00,#rrggbb@1.00" (2..8 stops, positions 0..1; unparseable = the default).
 */
import { GRADE_OP_KINDS, type GradeOpKind, type GradeParam, type OpDef, type OpParamSpec } from "./types";

const num = (label: string, min: number, max: number, def: number): OpParamSpec => ({ kind: "number", label, min, max, default: def });
const col = (label: string, def: string): OpParamSpec => ({ kind: "color", label, default: def });
const enm = (label: string, options: readonly string[], def: string): OpParamSpec => ({ kind: "enum", label, options, default: def });
const flag = (label: string, def: boolean): OpParamSpec => ({ kind: "bool", label, default: def });
const pts = (label: string, min: number, max: number, def: number[]): OpParamSpec => ({ kind: "points", label, min, max, default: def });
const mat = (label: string, min: number, max: number, def: number[]): OpParamSpec => ({ kind: "matrix", label, min, max, default: def });
const stops = (label: string, def: string): OpParamSpec => ({ kind: "stops", label, default: def });

export const IDENTITY_CURVE = [0, 0.25, 0.5, 0.75, 1];
const six = (v: number) => [v, v, v, v, v, v];
const NEUTRAL_STATS = [22, 0, 0, 12, 6, 6, 52, 0, 0, 16, 8, 8, 82, 0, 0, 12, 6, 6];

/** Chanmix presets (UI shortcuts; a recipe stores the matrix). Rows are output r, g, b. */
export const CHANMIX_PRESETS: Record<string, number[]> = {
  identity: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
  /** Infrared film: foliage (green) goes magenta-pink, sky goes deep blue. */
  aerochrome: [0.2, 0.9, 0, 0.5, 0, 0.2, 0, 0.5, 0.6, 0, 0, 0],
  brg: [0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0],
  gbr: [0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0],
  monoRed: [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0],
};

export const OP_DEFS: Record<GradeOpKind, OpDef> = {
  balance: {
    kind: "balance",
    label: "Balance",
    effect: "Exposure, white balance, contrast, saturation and vibrance in one.",
    colorOnly: true,
    animatable: true,
    params: {
      exposure: num("Exposure (stops)", -3, 3, 0),
      temp: num("Temperature", -1, 1, 0),
      tint: num("Tint", -1, 1, 0),
      contrast: num("Contrast", 0, 3, 1),
      pivot: num("Contrast pivot", 0.05, 0.95, 0.5),
      saturation: num("Saturation", 0, 3, 1),
      vibrance: num("Vibrance", -1, 1, 0),
    },
  },
  wheels: {
    kind: "wheels",
    label: "Colour wheels",
    effect: "Lift, gamma and gain per colour channel, plus an offset.",
    colorOnly: true,
    animatable: false,
    params: {
      lift: pts("Lift (shadows) R G B", -1, 1, [0, 0, 0]),
      gamma: pts("Gamma (mids) R G B", -1, 1, [0, 0, 0]),
      gain: pts("Gain (highlights) R G B", -1, 1, [0, 0, 0]),
      offset: num("Offset", -1, 1, 0),
    },
  },
  curves: {
    kind: "curves",
    label: "Curves",
    effect: "Master and per-channel tone curves through five points.",
    colorOnly: true,
    animatable: false,
    params: {
      master: pts("Master", 0, 1, IDENTITY_CURVE),
      r: pts("Red", 0, 1, IDENTITY_CURVE),
      g: pts("Green", 0, 1, IDENTITY_CURVE),
      b: pts("Blue", 0, 1, IDENTITY_CURVE),
    },
  },
  hsl: {
    kind: "hsl",
    label: "Hue / sat / lum",
    effect: "Shifts, saturates and brightens each of six colour families (red, yellow, green, cyan, blue, magenta).",
    colorOnly: true,
    animatable: false,
    params: {
      hue: pts("Hue shift (deg)", -180, 180, six(0)),
      sat: pts("Saturation", -1, 1, six(0)),
      lum: pts("Luminance", -1, 1, six(0)),
    },
  },
  split: {
    kind: "split",
    label: "Split tone",
    effect: "Tints the shadows and the highlights with two different colours.",
    colorOnly: true,
    animatable: true,
    params: {
      shadow: col("Shadows", "#1b3a6b"),
      highlight: col("Highlights", "#ffb36b"),
      balance: num("Balance", -1, 1, 0),
    },
  },
  gradmap: {
    kind: "gradmap",
    label: "Gradient map",
    effect: "Recolours the picture along a gradient driven by brightness, depth or hue.",
    colorOnly: true,
    animatable: true,
    params: {
      stops: stops("Gradient", "#0b0b3b@0.00,#ff3d81@0.50,#fff3b0@1.00"),
      source: enm("Driven by", ["luma", "depth", "hue"], "luma"),
      blend: enm("Blend", ["replace", "color", "soft"], "replace"),
      drift: num("Drift", -1, 1, 0),
    },
  },
  chanmix: {
    kind: "chanmix",
    label: "Channel mixer",
    effect: "Rewires red, green and blue into each other (infrared and other false colours).",
    colorOnly: true,
    animatable: false,
    params: { matrix: mat("Matrix (rows R G B, then bias)", -3, 3, CHANMIX_PRESETS.identity as number[]) },
  },
  solarize: {
    kind: "solarize",
    label: "Solarize",
    effect: "Flips every tone above a threshold, like a darkroom accident.",
    colorOnly: true,
    animatable: true,
    params: { threshold: num("Threshold", 0, 1, 0.5), mix: num("Mix", 0, 1, 1) },
  },
  posterize: {
    kind: "posterize",
    label: "Posterize",
    effect: "Cuts each channel down to a few flat levels.",
    colorOnly: true,
    animatable: false,
    params: { levels: num("Levels", 2, 16, 5) },
  },
  invert: {
    kind: "invert",
    label: "Invert",
    effect: "Flips the colours, per channel if you like.",
    colorOnly: true,
    animatable: false,
    params: { r: flag("Red", true), g: flag("Green", true), b: flag("Blue", true) },
  },
  huecycle: {
    kind: "huecycle",
    label: "Hue cycle",
    effect: "Rotates the hue by brightness, depth or distance from the centre: rainbow bands.",
    colorOnly: true,
    animatable: true,
    params: {
      by: enm("Driven by", ["luma", "depth", "radius"], "luma"),
      cycles: num("Cycles", 0, 8, 1),
      phase: num("Phase", 0, 1, 0),
    },
  },
  transfer: {
    kind: "transfer",
    label: "Steal a look",
    effect: "Moves the picture's colour statistics towards a reference picture's, per tonal band.",
    colorOnly: true,
    animatable: false,
    params: {
      stats: pts("Reference stats", -130, 130, NEUTRAL_STATS),
      src: pts("Source stats", -130, 130, NEUTRAL_STATS),
    },
  },
  bleach: {
    kind: "bleach",
    label: "Bleach bypass",
    effect: "Silvery, desaturated, contrasty film, as if the bleach step was skipped.",
    colorOnly: true,
    animatable: true,
    params: { mix: num("Mix", 0, 1, 1) },
  },
  glow: {
    kind: "glow",
    label: "Glow",
    effect: "Bright parts bloom into a wide soft halo.",
    colorOnly: false,
    animatable: true,
    params: { threshold: num("Threshold", 0, 2, 0.6), radius: num("Radius", 0, 1, 0.5), tint: col("Tint", "#ffffff"), gain: num("Gain", 0, 3, 1) },
  },
  halation: {
    kind: "halation",
    label: "Halation",
    effect: "A coloured film glow bleeding around bright edges.",
    colorOnly: false,
    animatable: true,
    params: { threshold: num("Threshold", 0, 1, 0.55), radius: num("Radius", 0, 1, 0.5), tint: col("Tint", "#ff5a2a") },
  },
  edgeglow: {
    kind: "edgeglow",
    label: "Edge glow",
    effect: "Draws the picture's edges as glowing neon lines.",
    colorOnly: false,
    animatable: true,
    params: { color: col("Colour", "#ff2bd6"), thickness: num("Thickness", 0.5, 4, 1.5), strength: num("Strength", 0, 3, 1) },
  },
  depthfog: {
    kind: "depthfog",
    label: "Depth fog",
    effect: "Colours the distance with fog, thicker the farther away.",
    colorOnly: false,
    animatable: true,
    needs: ["depth"],
    params: { color: col("Colour", "#ff9ed8"), start: num("Starts at", 0, 1, 0.4), density: num("Density", 0, 1, 0.6) },
  },
  tiltshift: {
    kind: "tiltshift",
    label: "Depth blur",
    effect: "Keeps one distance sharp and blurs the rest, like a miniature.",
    colorOnly: false,
    animatable: true,
    needs: ["depth"],
    params: { focus: num("Focus depth", 0, 1, 0.6), range: num("Sharp range", 0, 0.5, 0.15), blur: num("Blur", 0, 1, 0.5) },
  },
  grain: {
    kind: "grain",
    label: "Grain",
    effect: "Film grain.",
    colorOnly: false,
    animatable: true,
    params: { size: num("Size", 0.5, 4, 1.2), colored: num("Colour", 0, 1, 0.3) },
  },
  vignette: {
    kind: "vignette",
    label: "Vignette",
    effect: "Darkens the corners.",
    colorOnly: false,
    animatable: true,
    params: { size: num("Size", 0, 1, 0.55), softness: num("Softness", 0, 1, 0.6), roundness: num("Roundness", 0, 1, 0.5) },
  },
  chromatic: {
    kind: "chromatic",
    label: "Chromatic split",
    effect: "Pulls red and blue apart like a cheap lens.",
    colorOnly: false,
    animatable: false,
    params: { px: num("Split (px)", 0, 24, 6) },
  },
  halftone: {
    kind: "halftone",
    label: "Halftone",
    effect: "Printed dots, like comics.",
    colorOnly: false,
    animatable: false,
    params: { dots: num("Dots across", 20, 240, 90), angle: num("Angle", -90, 90, 45), mode: enm("Mode", ["mono", "color"], "color") },
  },
  glitch: {
    kind: "glitch",
    label: "Glitch",
    effect: "Torn slices and colour shifts, like corrupted video.",
    colorOnly: false,
    animatable: false,
    params: {},
  },
  vhs: {
    kind: "vhs",
    label: "VHS",
    effect: "Tape wobble, colour bleed, scanlines and noise.",
    colorOnly: false,
    animatable: false,
    params: { scanlines: num("Scanlines", 0, 1, 0.5), bleed: num("Colour bleed", 0, 1, 0.5), wobble: num("Wobble", 0, 1, 0.3), noise: num("Noise", 0, 1, 0.3) },
  },
  sharpen: {
    kind: "sharpen",
    label: "Sharpen",
    effect: "Crisper edges and fine detail.",
    colorOnly: false,
    animatable: false,
    params: { gain: num("Strength", 0, 2, 1) },
  },
  mirror: {
    kind: "mirror",
    label: "Kaleidoscope",
    effect: "Mirrored segments that slowly spin.",
    colorOnly: false,
    animatable: false,
    params: { segments: num("Segments", 2, 16, 6), spin: num("Spin", -1, 1, 0.15), zoom: num("Zoom", 0.5, 2, 1) },
  },
};

export function opDef(kind: GradeOpKind): OpDef | undefined {
  return OP_DEFS[kind];
}

export function isOpKind(s: string): s is GradeOpKind {
  return (GRADE_OP_KINDS as readonly string[]).includes(s);
}

/** A fresh copy of a kind's default params. */
export function defaultParams(kind: GradeOpKind): Record<string, GradeParam> {
  const out: Record<string, GradeParam> = {};
  for (const [k, spec] of Object.entries(OP_DEFS[kind].params)) out[k] = Array.isArray(spec.default) ? [...spec.default] : spec.default;
  return out;
}

/** An op's params with every missing one filled from the catalog (the values a pass actually uses). */
export function opParams(op: { kind: GradeOpKind; params: Record<string, GradeParam> }): Record<string, GradeParam> {
  const out = defaultParams(op.kind);
  for (const k of Object.keys(out)) {
    const v = op.params[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Kinds that run in the gradelook pass but can't go in a LUT (they look at the pixel's position). */
export const POINTWISE_KINDS: readonly GradeOpKind[] = ["grain", "vignette"];

/** The kinds the single `gradelook` pass runs (colour-only ops, then grain/vignette). */
export function isGradeLookKind(kind: GradeOpKind): boolean {
  return OP_DEFS[kind].colorOnly || POINTWISE_KINDS.includes(kind);
}
