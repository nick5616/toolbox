import { BRUSH_SCHEMA_VERSION, type BrushPreset, type DynamicsInput, type DynamicsTarget } from "@/paint/brushes/schema";

/** A schema-complete brush with neutral values; presets and "New brush" start here. */
export function defaultBrush(over: Partial<BrushPreset> = {}): BrushPreset {
  return {
    version: BRUSH_SCHEMA_VERSION,
    id: "default",
    name: "Brush",
    set: "user",
    size: 24,
    minSize: 0.2,
    opacity: 1,
    flow: 1,
    spacing: 0.1,
    scatter: 0,
    count: 1,
    taper: { start: 0, end: 0, byPressure: true },
    tip: { shape: "round", hardness: 0.8, roundness: 1, angle: 0, angleMode: "fixed", rotationJitter: 0, invert: false },
    dual: null,
    grain: { texture: "", mode: "moving", scale: 1, depth: 0.5, contrast: 1 },
    dynamics: [
      { input: "pressure", target: "size", amount: 0.8, curve: [[0, 0], [1, 1]] },
      { input: "pressure", target: "opacity", amount: 0.3, curve: [[0, 0], [1, 1]] },
    ],
    color: { hueJitter: 0, satJitter: 0, briJitter: 0, perStroke: false, secondaryMix: 0 },
    wet: { mix: 0, dilution: 0, charge: 0, pull: 0, grade: 0, edges: 0, bleed: 0 },
    rendering: "light-glaze",
    impasto: 0,
    blend: "normal",
    smoothing: { streamline: 0.2, stabilisation: 0, motionFilter: 0 },
    antialias: true,
    credit: "",
    license: "",
    fidelity: [],
    ...over,
  };
}

/** A deep copy (brushes are edited as working copies). */
export function cloneBrush(b: BrushPreset): BrushPreset {
  return JSON.parse(JSON.stringify(b)) as BrushPreset;
}

export const DYNAMICS_INPUTS: DynamicsInput[] = ["pressure", "tilt", "velocity", "progress"];
export const DYNAMICS_TARGETS: DynamicsTarget[] = ["size", "opacity", "flow", "scatter", "hue"];

/** A copy of `b` with a fresh id and name, for "Duplicate and edit". */
export function duplicateBrush(b: BrushPreset, set: string, id: string): BrushPreset {
  return { ...cloneBrush(b), id, set, name: `${b.name} copy`, credit: b.credit, license: b.license, fidelity: [...b.fidelity] };
}
