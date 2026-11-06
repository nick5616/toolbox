// A complete BrushPreset with neutral values: the base every bundled and
// imported brush is built from, and what tests and PaintLab start with.

import { BRUSH_SCHEMA_VERSION, type BrushPreset } from "./schema";

export function defaultBrush(over: Partial<BrushPreset> = {}): BrushPreset {
  return {
    version: BRUSH_SCHEMA_VERSION,
    id: "default",
    name: "Default",
    set: "Default",
    size: 20,
    minSize: 1,
    opacity: 1,
    flow: 1,
    spacing: 0.1,
    scatter: 0,
    count: 1,
    taper: { start: 0, end: 0, byPressure: false },
    tip: { shape: "round", hardness: 1, roundness: 1, angle: 0, angleMode: "fixed", rotationJitter: 0, invert: false },
    dual: null,
    grain: { texture: "", mode: "moving", scale: 1, depth: 0, contrast: 1 },
    dynamics: [],
    color: { hueJitter: 0, satJitter: 0, briJitter: 0, perStroke: false, secondaryMix: 0 },
    wet: { mix: 0, dilution: 0, charge: 1, pull: 0, grade: 0, edges: 0, bleed: 0 },
    rendering: "light-glaze",
    impasto: 0,
    blend: "normal",
    smoothing: { streamline: 0, stabilisation: 0, motionFilter: 0 },
    antialias: true,
    credit: "",
    license: "",
    fidelity: [],
    ...over,
  };
}
