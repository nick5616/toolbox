// The perception tools of the Lab (SPEC §1.4.2). Descriptions only: the queue
// (queue.ts) and the ops (ops.ts) run them. History brush belongs to the
// engine (P1) and is not listed here.

import type { PerceptionToolInfo, LabParam } from "../lab/types";

/** The Origin.Model names of PaintService.Origins() (modules/paint/origins.go). */
export const MODEL_LAMA = "LaMa (big-lama)";
export const MODEL_MIGAN = "MI-GAN (Places2)";
export const MODEL_CUTOUT = "BiRefNet / IS-Net";
export const MODEL_SAM = "SAM 2.1 tiny";
export const MODEL_ESRGAN = "Real-ESRGAN x4plus";

const quality: LabParam = {
  id: "quality",
  label: "Model",
  type: "choice",
  choices: [
    { value: "best", label: "Best (LaMa)" },
    { value: "fast", label: "Fast (MI-GAN)" },
  ],
  default: "best",
  tip: "Best fills with LaMa and keeps full detail; Fast uses a smaller model on a downscaled context.",
};

const sampleAll: LabParam = {
  id: "sampleAll",
  label: "Sample all layers",
  type: "toggle",
  default: false,
  tip: "Fill from what you see (all visible layers) instead of only the current layer.",
};

const passes = (def: number): LabParam => ({
  id: "passes",
  label: "Passes",
  type: "number",
  min: 1,
  max: 12,
  step: 1,
  default: def,
  tip: "How many times the fill is fed back into itself. Each pass inpaints the previous result.",
});

const ghost: LabParam = {
  id: "ghost",
  label: "Ghost",
  type: "number",
  min: 0,
  max: 1,
  step: 0.01,
  default: 0,
  tip: "Blends each pass over the last, so things fade instead of vanishing.",
};

const drift: LabParam = {
  id: "drift",
  label: "Drift",
  type: "number",
  min: 0,
  max: 1,
  step: 0.01,
  default: 0,
  tip: "A seeded jitter of the mask's growth and offset, so each pass reconstructs from slightly different context. At 0 re-rolls give the same result.",
};

const scale: LabParam = {
  id: "scale",
  label: "Scale",
  type: "choice",
  choices: [
    { value: "2", label: "×2" },
    { value: "4", label: "×4" },
  ],
  default: "2",
  tip: "How much the detail is enlarged.",
};

const cutoutQuality: LabParam = {
  id: "quality",
  label: "Model",
  type: "choice",
  choices: [
    { value: "fast", label: "Fast" },
    { value: "balanced", label: "Balanced" },
    { value: "best", label: "Best" },
  ],
  default: "balanced",
  tip: "Trades speed for a cleaner cut-out edge.",
};

export const PERCEPTION_TOOLS: PerceptionToolInfo[] = [
  {
    id: "fill-eraser",
    label: "Fill eraser",
    description: "Paint a mask; the area is filled in from its surroundings.",
    kind: "perception",
    predictability: "exact",
    origin: { kind: "model", model: MODEL_LAMA },
    params: [quality, sampleAll],
    icon: "fill-eraser",
    op: "fill",
  },
  {
    id: "dissolve",
    label: "Dissolve",
    description: "Fill fed back into itself: each pass inpaints the previous pass's result.",
    kind: "perception",
    predictability: "seeded",
    origin: { kind: "model", model: MODEL_LAMA },
    params: [passes(4), ghost, drift, quality, sampleAll],
    icon: "dissolve",
    op: "fill",
  },
  {
    id: "melt",
    label: "Melt",
    description: "Dissolve whose mask grows each pass in one direction, so forms drip.",
    kind: "perception",
    predictability: "seeded",
    origin: { kind: "model", model: MODEL_LAMA },
    params: [
      {
        id: "direction",
        label: "Direction",
        type: "choice",
        choices: [
          { value: "down", label: "Down" },
          { value: "up", label: "Up" },
          { value: "left", label: "Left" },
          { value: "right", label: "Right" },
        ],
        default: "down",
        tip: "The way the mask grows on every pass.",
      },
      passes(6),
      ghost,
      drift,
      quality,
    ],
    icon: "melt",
    op: "fill",
  },
  {
    id: "echo-fill",
    label: "Echo fill",
    description: "Fills the stroke from a shifted copy of its surroundings, so the model reconstructs stuttered repeats.",
    kind: "perception",
    predictability: "exact",
    origin: { kind: "model", model: MODEL_LAMA },
    params: [
      { id: "offsetX", label: "Offset X", type: "number", min: -512, max: 512, step: 1, default: 24, tip: "Horizontal shift of the context, in pixels." },
      { id: "offsetY", label: "Offset Y", type: "number", min: -512, max: 512, step: 1, default: 0, tip: "Vertical shift of the context, in pixels." },
      quality,
    ],
    icon: "echo-fill",
    op: "fill",
  },
  {
    id: "edge-erode",
    label: "Edge erode",
    description: "Only the outer ring of the stroke is inpainted, so shapes lose their edges into the ground.",
    kind: "perception",
    predictability: "exact",
    origin: { kind: "model", model: MODEL_LAMA },
    params: [
      { id: "width", label: "Edge width", type: "number", min: 1, max: 128, step: 1, default: 8, tip: "How deep the eroded ring is, in pixels." },
      quality,
    ],
    icon: "edge-erode",
    op: "fill",
  },
  {
    id: "subject-stamp",
    label: "Subject stamp",
    description: "Click a photo layer once to cut out its subject; the cut-out becomes a stamp tip scattered along the stroke.",
    kind: "perception",
    predictability: "exact",
    origin: { kind: "model", model: MODEL_CUTOUT },
    params: [cutoutQuality],
    icon: "subject-stamp",
    op: "cutout",
  },
  {
    id: "select-subject",
    label: "Select subject",
    description: "Makes a selection from background removal. Can also cut the subject to a new layer.",
    kind: "perception",
    predictability: "exact",
    origin: { kind: "model", model: MODEL_CUTOUT },
    params: [cutoutQuality, sampleAll],
    icon: "select-subject",
    op: "cutout",
  },
  {
    id: "select-object",
    label: "Select object",
    description: "Click (positive) and Alt-click (negative) points; the mask previews live and Enter makes it the selection.",
    kind: "perception",
    predictability: "exact",
    origin: { kind: "model", model: MODEL_SAM },
    params: [sampleAll],
    icon: "select-object",
    op: "segment",
  },
  {
    id: "enhance-brush",
    label: "Enhance brush",
    description: "Upscales the stroke area and resamples it back, inventing crisp detail.",
    kind: "perception",
    predictability: "exact",
    origin: { kind: "model", model: MODEL_ESRGAN },
    params: [scale, sampleAll],
    icon: "enhance-brush",
    op: "enhance",
  },
  {
    id: "extend-canvas",
    label: "Extend canvas with fill",
    description: "Grows the canvas on chosen sides and fills the new margins from the edges.",
    kind: "perception",
    predictability: "exact",
    origin: { kind: "model", model: MODEL_LAMA },
    params: [
      { id: "left", label: "Left", type: "toggle", default: false, tip: "Grow the left side." },
      { id: "right", label: "Right", type: "toggle", default: true, tip: "Grow the right side." },
      { id: "top", label: "Top", type: "toggle", default: false, tip: "Grow the top." },
      { id: "bottom", label: "Bottom", type: "toggle", default: false, tip: "Grow the bottom." },
      { id: "px", label: "Pixels", type: "number", min: 16, max: 4096, step: 16, default: 512, tip: "How far each chosen side grows." },
      quality,
    ],
    icon: "extend-canvas",
    op: "fill",
  },
  {
    id: "upscale-canvas",
    label: "Upscale canvas",
    description: "Upscales the whole canvas, as a new project or in place.",
    kind: "perception",
    predictability: "exact",
    origin: { kind: "model", model: MODEL_ESRGAN },
    params: [
      scale,
      {
        id: "target",
        label: "Result",
        type: "choice",
        choices: [
          { value: "new", label: "New project" },
          { value: "inplace", label: "In place" },
        ],
        default: "new",
        tip: "A new project keeps this one as it is.",
      },
    ],
    icon: "upscale-canvas",
    op: "enhance",
  },
];

export function perceptionTool(id: string): PerceptionToolInfo | undefined {
  return PERCEPTION_TOOLS.find((t) => t.id === id);
}

/** Default values of a tool's params. */
export function defaultParams(tool: PerceptionToolInfo): Record<string, number | string | boolean> {
  return Object.fromEntries(tool.params.map((p) => [p.id, p.default]));
}
