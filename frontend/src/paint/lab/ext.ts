// Optional extensions of the frozen LabContext / LabTool (Phase 19, P2).
//
// The frozen contract in types.ts is all a tool strictly needs. These extras
// make tools nicer when the engine provides them, and every tool falls back
// when a field is missing, so the engine can add them at its own pace.

import type { InputPoint, Rect, RGBA } from "../engine/types";
import type { LabContext, LabTool } from "./types";

/** How one batch of dabs should look when it differs from the current brush. */
export interface DabStyle {
  /** "brush" / undefined = the current tip; otherwise a library tip name, e.g. "lib:leaf-simple". */
  tip?: string;
  /** Straight 0..1 colour override. */
  color?: RGBA;
  /** Multiplies the brush size (default 1). */
  sizeScale?: number;
  /** Multiplies the dab opacity (default 1). */
  opacity?: number;
  /** Rotates the tip, degrees (default: follow the brush's own angle). */
  angle?: number;
}

/** What the engine may additionally give a tool. All optional. */
export interface LabContextExt {
  /** Current brush size in canvas px (diameter at full pressure). Fallback: 32. */
  brushSize?: number;
  /** 0..1, 1 = hard edge. Fallback: 0.5. */
  brushHardness?: number;
  /** Current colour. Fallback: near black. */
  color?: RGBA;
  /** Like dab(), with a per-batch style (tip, colour, size). Fallback: dab(). */
  dabAs?(points: InputPoint[], style: DabStyle): void;
  /**
   * Empties the stroke's scratch target inside r. Tools that re-render their
   * whole result each tick (Reaction-diffusion, Ink bleed, Pixel sort, Smear)
   * call it before composite(); without it they composite their final result
   * only (Pixel sort, Smear) or accumulate (Reaction-diffusion, Ink bleed).
   */
  clearScratch?(r: Rect): void;
}

export type LabContextX = LabContext & LabContextExt;

export function ext(ctx: LabContext): LabContextX {
  return ctx as LabContextX;
}

/**
 * Tools that read snapshots work asynchronously (LabContext.snapshot returns a
 * promise). The engine awaits flush() after onStrokeEnd (and before it commits
 * the stroke); it resolves when every queued piece of work has been composited.
 */
export interface AsyncLabTool extends LabTool {
  flush(): Promise<void>;
}

/** Every tool in this folder has flush(), a no-op for the synchronous ones. */
export function flushTool(t: LabTool): Promise<void> {
  const f = (t as Partial<AsyncLabTool>).flush;
  return f ? f.call(t) : Promise.resolve();
}
