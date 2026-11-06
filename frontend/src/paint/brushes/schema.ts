// Brush preset JSON (Phase 19, SPEC §1.3.1). FROZEN in Wave 0: P1's engine
// renders it, B1 writes the bundled library and the importers' output, P5's
// Brush Studio edits it. Go stores it as opaque JSON.

export const BRUSH_SCHEMA_VERSION = 1;

/** A curve from input 0..1 to output 0..1: sorted control points, monotone cubic between them. */
export type Curve = Array<[number, number]>;

export type DynamicsInput = "pressure" | "tilt" | "velocity" | "progress";
export type DynamicsTarget = "size" | "opacity" | "flow" | "scatter" | "hue";

export interface Dynamics {
  input: DynamicsInput;
  target: DynamicsTarget;
  /** Fraction of the target's range the input can move it (0..1). */
  amount: number;
  curve: Curve;
}

export interface Tip {
  /** "round" | "square" | an image: "lib:<file>" (bundled) or "set:<setId>/<file>" (user/imported). */
  shape: string;
  hardness: number; // 0..1 (round/square only)
  roundness: number; // 0.05..1
  angle: number; // degrees
  angleMode: "fixed" | "stroke" | "tilt";
  rotationJitter: number; // 0..1
  /** Invert the tip image (white = paint by default). */
  invert: boolean;
}

export interface Grain {
  texture: string; // "" = none; "lib:<file>" | "set:<setId>/<file>"
  mode: "moving" | "texturised";
  scale: number; // 0.1..4
  depth: number; // 0..1
  contrast: number; // 0..2
}

export interface Wet {
  mix: number; // 0..1 wet mix (picks up colour)
  dilution: number; // 0..1
  charge: number; // 0..1
  pull: number; // 0..1
  grade: number; // 0..1
  edges: number; // 0..1 wet edges
  bleed: number; // 0..1 water spreading after the stroke
}

export interface ColorDynamics {
  hueJitter: number; // 0..1 per dab
  satJitter: number;
  briJitter: number;
  perStroke: boolean; // jitter once per stroke instead of per dab
  secondaryMix: number; // 0..1 foreground ↔ secondary by pressure
}

export interface Smoothing {
  streamline: number; // 0..1
  stabilisation: number; // 0..1
  motionFilter: number; // 0..1
}

export interface BrushPreset {
  version: typeof BRUSH_SCHEMA_VERSION;
  id: string;
  name: string;
  /** Bundled set name or user set ID. */
  set: string;
  /** Pixels at full pressure and 100% size slider. */
  size: number;
  minSize: number; // 0..1 of size at zero pressure
  opacity: number; // 0..1
  flow: number; // 0..1
  spacing: number; // fraction of size, 0.01..5
  scatter: number; // 0..1 of size
  count: number; // dabs per spacing step, 1..16
  taper: { start: number; end: number; byPressure: boolean };
  tip: Tip;
  dual: Tip | null;
  grain: Grain;
  dynamics: Dynamics[];
  color: ColorDynamics;
  wet: Wet;
  rendering: "light-glaze" | "uniform-glaze" | "intense" | "heavy";
  impasto: number; // 0..1 (heavy rendering only)
  blend: "normal" | "multiply" | "screen" | "add" | "erase";
  smoothing: Smoothing;
  /** "aliased" for pixel brushes (nearest neighbour, no AA). */
  antialias: boolean;
  /** Attribution for bundled open-licence or imported brushes. */
  credit: string;
  license: string;
  /** Importer notes ("spacing approximated"). */
  fidelity: string[];
}
