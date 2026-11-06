// Lab tool contract (Phase 19, SPEC §1.4, §2.4). FROZEN in Wave 0: P2
// implements the algorithmic tools, P6 the perception tools, P5 renders the
// Lab panel, predictability badges and origin cards from these.

import type { InputPoint, Rect } from "../engine/types";

/** Exact: same input, same result. Seeded: random, repeatable with a locked seed. Wild: can't be fully predicted. */
export type Predictability = "exact" | "seeded" | "wild";

export type LabOrigin =
  | { kind: "algorithm"; text: string }
  /** model: the Origin.Model name from PaintService.Origins(). */
  | { kind: "model"; model: string };

/**
 * A tool parameter, shown as a device control (Ableton-style knob, slider or
 * switch). `rand: false` keeps it out of the device's Rand button (e.g. a
 * colour palette the user picked on purpose); every other param is
 * randomised within its range. `unit` labels the readout ("px", "%", "°").
 */
export type LabParam =
  | { id: string; label: string; type: "number"; min: number; max: number; step?: number; default: number; tip: string; rand?: boolean; unit?: string; curve?: "linear" | "exp" }
  | { id: string; label: string; type: "choice"; choices: Array<{ value: string; label: string }>; default: string; tip: string; rand?: boolean }
  | { id: string; label: string; type: "toggle"; default: boolean; tip: string; rand?: boolean };

export type LabParams = Record<string, number | string | boolean>;

export interface LabToolInfo {
  id: string;
  label: string;
  /** One line for tooltips and the Lab panel. */
  description: string;
  kind: "algorithmic" | "perception";
  predictability: Predictability;
  origin: LabOrigin;
  params: LabParam[];
  /** Custom icon name in tools/paint/ui/icons (P5). */
  icon: string;
}

/** What an algorithmic tool gets while it paints (P1 provides it). */
export interface LabContext {
  /** Seeded RNG; the same key and seed give the same sequence. */
  rng(key: string): () => number;
  /** The active layer's pixels when the stroke began, for snapshot effects. */
  snapshot(r: Rect): Promise<ImageData>;
  /** GL access for shader tools (P1's backend; null on the CPU test backend). */
  gl: WebGL2RenderingContext | null;
  /** Draw dabs with the current brush along a path (Growth, Flow field, Particles). */
  dab(points: InputPoint[]): void;
  /** Composite an image into the stroke's scratch target through a mask. */
  composite(img: ImageData | ImageBitmap, r: Rect, mask?: ImageData): void;
  params: LabParams;
  seed: number;
}

export interface LabTool extends LabToolInfo {
  kind: "algorithmic";
  onStrokeBegin(ctx: LabContext, p: InputPoint): void;
  onStrokeExtend(ctx: LabContext, points: InputPoint[]): void;
  onStrokeEnd(ctx: LabContext): void;
  /**
   * Tools that keep evolving after the stroke (Reaction–diffusion, Ink bleed,
   * Particles) advance one fixed tick per call; return false when settled.
   * Ticks come from a counter, never wall time.
   */
  step?(ctx: LabContext, tick: number): boolean;
}

/** Perception tools are described here; P6's queue runs them. */
export interface PerceptionToolInfo extends LabToolInfo {
  kind: "perception";
  /** The engine operation (PaintAIOp) it calls. */
  op: "fill" | "cutout" | "segment" | "enhance";
}
