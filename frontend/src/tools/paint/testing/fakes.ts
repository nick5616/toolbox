/**
 * Stand-ins for the modules P1/P2/P6/B1 own, used until the architect wires
 * the real ones in engine-adapter.ts. Everything conforms to the frozen
 * contracts (BrushPreset schema, LabToolInfo, PaintOrigin).
 */
import type { PaintOrigin } from "@/lib/api";
import type { BrushPreset } from "@/paint/brushes/schema";
import type { LabToolInfo, PerceptionToolInfo } from "@/paint/lab/types";
import { defaultBrush } from "../brushDefaults";

export const FAKE_BRUSHES: BrushPreset[] = [
  defaultBrush({ id: "hb", name: "HB Pencil", set: "sketching", size: 6, spacing: 0.08, tip: { shape: "round", hardness: 0.9, roundness: 1, angle: 0, angleMode: "fixed", rotationJitter: 0, invert: false } }),
  defaultBrush({ id: "soft-round", name: "Soft Round", set: "painting", size: 40, opacity: 0.9, tip: { shape: "round", hardness: 0.1, roundness: 1, angle: 0, angleMode: "fixed", rotationJitter: 0, invert: false } }),
  defaultBrush({ id: "fine-liner", name: "Fine Liner", set: "inking", size: 4, minSize: 0.5, smoothing: { streamline: 0.6, stabilisation: 0.2, motionFilter: 0.3 } }),
  defaultBrush({ id: "oak-leaves", name: "Oak Leaves", set: "nature", size: 60, scatter: 0.6, spacing: 0.9, count: 2, tip: { shape: "lib:leaf-oak.png", hardness: 1, roundness: 1, angle: 0, angleMode: "stroke", rotationJitter: 0.4, invert: false }, credit: "Paint+" }),
  defaultBrush({ id: "eraser-soft", name: "Soft Eraser", set: "erasers", size: 50, blend: "erase", tip: { shape: "round", hardness: 0.2, roundness: 1, angle: 0, angleMode: "fixed", rotationJitter: 0, invert: false } }),
];

export const FAKE_SET_NAMES: Record<string, string> = {
  sketching: "Sketching",
  inking: "Inking",
  painting: "Painting",
  nature: "Nature",
  erasers: "Erasers",
};

export const FAKE_ORIGINS: PaintOrigin[] = [
  {
    model: "LaMa (big-lama)",
    usedBy: "Fill eraser, Dissolve, Melt, Echo fill, Edge erode, Extend canvas",
    license: "Apache-2.0",
    trainedOn: "Places2 scene photographs",
    generates: "Fills holes from the surrounding image; no prompts and no style of any artist",
    source: "github.com/advimman/lama",
  },
  {
    model: "BiRefNet",
    usedBy: "Subject stamp, Select subject",
    license: "MIT",
    trainedOn: "Segmentation datasets of photographs (DIS5K, HRSOD)",
    generates: "No: outputs a mask",
    source: "",
  },
];

const num = (id: string, label: string, min: number, max: number, def: number, tip: string, step?: number) => ({ id, label, type: "number" as const, min, max, default: def, tip, ...(step ? { step } : {}) });

export const FAKE_ALGORITHMIC: LabToolInfo[] = [
  {
    id: "flow-field",
    label: "Flow field",
    description: "The brush follows a curl-noise field, so a straight stroke becomes a swirling bundle of hairs.",
    kind: "algorithmic",
    predictability: "seeded",
    origin: { kind: "algorithm", text: "Curl noise over a simplex field; each dab steps along the field's curl." },
    params: [num("scale", "Scale", 1, 100, 24, "Size of the swirls"), num("turbulence", "Turbulence", 0, 1, 0.4, "How tangled the field is", 0.01)],
    icon: "flow",
  },
  {
    id: "pixel-sort",
    label: "Pixel sort",
    description: "Sorts pixels along the stroke direction by a luminance threshold.",
    kind: "algorithmic",
    predictability: "exact",
    origin: { kind: "algorithm", text: "A stable sort of pixel runs along the stroke by luminance." },
    params: [num("threshold", "Threshold", 0, 1, 0.5, "Luminance cut-off", 0.01), { id: "reverse", label: "Reverse", type: "toggle", default: false, tip: "Sort dark to light instead" }],
    icon: "sort",
  },
  {
    id: "growth",
    label: "Growth",
    description: "An L-system grows branches, twigs and leaves from your stroke.",
    kind: "algorithmic",
    predictability: "seeded",
    origin: { kind: "algorithm", text: "A stochastic L-system rewriting your stroke as a spine." },
    params: [num("depth", "Depth", 1, 8, 4, "Branching generations")],
    icon: "growth",
  },
  {
    id: "glitch",
    label: "Glitch slice",
    description: "Shifts horizontal slices of the picture under the brush.",
    kind: "algorithmic",
    predictability: "wild",
    origin: { kind: "algorithm", text: "Random slice offsets from a seeded generator." },
    params: [{ id: "mode", label: "Mode", type: "choice", choices: [{ value: "slice", label: "Slice" }, { value: "block", label: "Block" }], default: "slice", tip: "Shape of the glitches" }],
    icon: "glitch",
  },
];

export const FAKE_PERCEPTION: PerceptionToolInfo[] = [
  {
    id: "fill-eraser",
    label: "Fill eraser",
    description: "Paint a mask; the area is filled in from its surroundings.",
    kind: "perception",
    predictability: "exact",
    origin: { kind: "model", model: "LaMa (big-lama)" },
    params: [{ id: "model", label: "Quality", type: "choice", choices: [{ value: "fast", label: "Fast" }, { value: "best", label: "Best" }], default: "fast", tip: "Fast is quicker, Best is cleaner" }],
    icon: "fillEraser",
    op: "fill",
  },
  {
    id: "dissolve",
    label: "Dissolve",
    description: "Fill fed back into itself: forms dissolve into soft ghosts.",
    kind: "perception",
    predictability: "seeded",
    origin: { kind: "model", model: "LaMa (big-lama)" },
    params: [num("passes", "Passes", 1, 12, 6, "How many times it dissolves"), num("ghost", "Ghost", 0, 1, 0.3, "How much of each pass survives", 0.01), num("drift", "Drift", 0, 1, 0.5, "Jitter between passes", 0.01)],
    icon: "dissolve",
    op: "fill",
  },
  {
    id: "select-subject",
    label: "Select subject",
    description: "Makes a selection of the main subject.",
    kind: "perception",
    predictability: "exact",
    origin: { kind: "model", model: "BiRefNet" },
    params: [],
    icon: "subject",
    op: "cutout",
  },
  {
    id: "select-object",
    label: "Select object",
    description: "Click an object (Alt-click to remove) to select it.",
    kind: "perception",
    predictability: "exact",
    origin: { kind: "model", model: "SAM 2.1 tiny" },
    params: [],
    icon: "object",
    op: "segment",
  },
  {
    id: "enhance",
    label: "Enhance brush",
    description: "Upscales the stroke area and resamples it back, inventing crisp detail.",
    kind: "perception",
    predictability: "exact",
    origin: { kind: "model", model: "Real-ESRGAN" },
    params: [],
    icon: "enhance",
    op: "enhance",
  },
];
