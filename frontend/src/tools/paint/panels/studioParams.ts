/** Brush Studio's parameter table: every numeric/enum/toggle field of the brush schema, grouped. */
import type { BrushPreset, Curve } from "@/paint/brushes/schema";

export type StudioKind = "number" | "choice" | "toggle";

export interface StudioParam {
  group: string;
  label: string;
  /** Dotted path into BrushPreset ("tip.hardness"). */
  path: string;
  kind: StudioKind;
  min?: number;
  max?: number;
  step?: number;
  choices?: Array<{ value: string; label: string }>;
  /** Resolved at render time from the runtime's asset lists. */
  assets?: "tip" | "grain";
  tip: string;
}

const n = (group: string, label: string, path: string, min: number, max: number, step: number, tip: string): StudioParam => ({ group, label, path, kind: "number", min, max, step, tip });
const c = (group: string, label: string, path: string, choices: Array<[string, string]>, tip: string): StudioParam => ({ group, label, path, kind: "choice", choices: choices.map(([value, label]) => ({ value, label })), tip });
const t = (group: string, label: string, path: string, tip: string): StudioParam => ({ group, label, path, kind: "toggle", tip });

export const STUDIO_GROUPS = ["Shape", "Stroke", "Grain", "Colour", "Wet", "Rendering", "Smoothing"] as const;

export const STUDIO_PARAMS: StudioParam[] = [
  { group: "Shape", label: "Tip", path: "tip.shape", kind: "choice", assets: "tip", tip: "The shape stamped by every dab" },
  n("Shape", "Hardness", "tip.hardness", 0, 1, 0.01, "Soft or hard edge (round and square tips)"),
  n("Shape", "Roundness", "tip.roundness", 0.05, 1, 0.01, "Squash the tip into an ellipse"),
  n("Shape", "Angle", "tip.angle", 0, 360, 1, "Rotation of the tip, in degrees"),
  c("Shape", "Angle follows", "tip.angleMode", [["fixed", "Fixed"], ["stroke", "Stroke"], ["tilt", "Tilt"]], "Whether the tip turns with the stroke or the pen's tilt"),
  n("Shape", "Rotation jitter", "tip.rotationJitter", 0, 1, 0.01, "Random turn of each dab"),
  t("Shape", "Invert tip", "tip.invert", "Swap where the tip image paints"),
  n("Stroke", "Size", "size", 1, 400, 1, "Pixels at full pressure"),
  n("Stroke", "Min size", "minSize", 0, 1, 0.01, "Size at zero pressure, as a fraction of Size"),
  n("Stroke", "Opacity", "opacity", 0, 1, 0.01, "How solid the stroke is"),
  n("Stroke", "Flow", "flow", 0, 1, 0.01, "How much paint each dab lays down"),
  n("Stroke", "Spacing", "spacing", 0.01, 5, 0.01, "Distance between dabs, as a fraction of size"),
  n("Stroke", "Scatter", "scatter", 0, 1, 0.01, "Random offset of each dab"),
  n("Stroke", "Count", "count", 1, 16, 1, "Dabs per spacing step"),
  n("Stroke", "Taper in", "taper.start", 0, 1, 0.01, "How gently the stroke starts"),
  n("Stroke", "Taper out", "taper.end", 0, 1, 0.01, "How gently the stroke ends"),
  t("Stroke", "Taper by pressure", "taper.byPressure", "Taper follows pressure instead of length"),
  { group: "Grain", label: "Texture", path: "grain.texture", kind: "choice", assets: "grain", tip: "A paper or canvas texture the paint catches on" },
  c("Grain", "Mode", "grain.mode", [["moving", "Moving"], ["texturised", "Fixed to canvas"]], "Moving grain follows the stroke; fixed grain stays on the canvas"),
  n("Grain", "Scale", "grain.scale", 0.1, 4, 0.01, "Size of the texture"),
  n("Grain", "Depth", "grain.depth", 0, 1, 0.01, "How strongly the texture shows"),
  n("Grain", "Contrast", "grain.contrast", 0, 2, 0.01, "Contrast of the texture"),
  n("Colour", "Hue jitter", "color.hueJitter", 0, 1, 0.01, "Random hue shift"),
  n("Colour", "Saturation jitter", "color.satJitter", 0, 1, 0.01, "Random saturation shift"),
  n("Colour", "Brightness jitter", "color.briJitter", 0, 1, 0.01, "Random brightness shift"),
  t("Colour", "Jitter per stroke", "color.perStroke", "Jitter once per stroke instead of per dab"),
  n("Colour", "Second colour mix", "color.secondaryMix", 0, 1, 0.01, "Blend toward the second colour with pressure"),
  n("Wet", "Wet mix", "wet.mix", 0, 1, 0.01, "How much colour the brush picks up"),
  n("Wet", "Dilution", "wet.dilution", 0, 1, 0.01, "Water in the paint"),
  n("Wet", "Charge", "wet.charge", 0, 1, 0.01, "Paint loaded on the brush"),
  n("Wet", "Pull", "wet.pull", 0, 1, 0.01, "How far paint is dragged"),
  n("Wet", "Grade", "wet.grade", 0, 1, 0.01, "Fade of loaded paint"),
  n("Wet", "Wet edges", "wet.edges", 0, 1, 0.01, "Darker rims, like watercolour"),
  n("Wet", "Bleed", "wet.bleed", 0, 1, 0.01, "Water spreading after the stroke"),
  c("Rendering", "Rendering", "rendering", [["light-glaze", "Light glaze"], ["uniform-glaze", "Uniform glaze"], ["intense", "Intense"], ["heavy", "Heavy paint"]], "How dabs build up"),
  n("Rendering", "Impasto", "impasto", 0, 1, 0.01, "Paint thickness (heavy paint only)"),
  c("Rendering", "Blend", "blend", [["normal", "Normal"], ["multiply", "Multiply"], ["screen", "Screen"], ["add", "Add"], ["erase", "Erase"]], "How each dab mixes with what's below"),
  t("Rendering", "Antialiased", "antialias", "Off for pixel brushes (hard, aliased edges)"),
  n("Smoothing", "StreamLine", "smoothing.streamline", 0, 1, 0.01, "A lagging spring that smooths the line"),
  n("Smoothing", "Stabilisation", "smoothing.stabilisation", 0, 1, 0.01, "A pulled-string average for steady lines"),
  n("Smoothing", "Motion filter", "smoothing.motionFilter", 0, 1, 0.01, "Removes jitter at the extremes"),
];

export function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** An immutable update of a dotted path. */
export function setPath<T extends object>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split(".");
  if (!head) return obj;
  const cur = (obj as Record<string, unknown>)[head];
  return { ...obj, [head]: rest.length ? setPath((cur ?? {}) as object, rest.join("."), value) : value } as T;
}

/** Sorted, de-duplicated curve with the end points pinned at x = 0 and x = 1. */
export function normaliseCurve(points: Curve): Curve {
  const sorted = [...points].map(([x, y]) => [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: Curve = [];
  for (const p of sorted) if (!out.length || p[0] - (out[out.length - 1]?.[0] ?? -1) > 0.001) out.push(p);
  if (out.length < 2) return [[0, 0], [1, 1]];
  out[0] = [0, out[0]?.[1] ?? 0];
  out[out.length - 1] = [1, out[out.length - 1]?.[1] ?? 1];
  return out;
}

export function hasDual(b: BrushPreset): boolean {
  return b.dual !== null;
}
