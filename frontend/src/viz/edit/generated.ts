/**
 * Generated clip sources (Phase 9 Part B): text and visual clips draw their
 * picture into a frame-sized target each frame; the engine then treats that
 * target like a photo (transform, masks, effects, blend, track mattes and
 * transitions all apply). Kinds register a factory here; the engine keeps
 * one instance per clip and disposes it when the clip leaves the edit.
 *
 * CONTRACT (Part B foundation): frozen. textClip.ts (FX4) and visualClip.ts
 * (FX5) register; nothing else may.
 */
import type { Fullscreen, Target } from "../gl/core";
import type { FrameInput } from "../layers/registry";
import type { ResolvedPalette } from "../palette";
import type { CompiledClip } from "./compile";
import type { Marker } from "./types";
import type { ParamContext } from "./params";

export interface GeneratorContext {
  gl: WebGL2RenderingContext;
  fullscreen: Fullscreen;
  /** Output size. */
  w: number;
  h: number;
  /** Per-clip seed (engine seed ^ hash of the clip id). */
  seed: number;
  inWorker: boolean;
}

export interface GeneratorFrame {
  /** The clip (its `text` or `visual` is set). */
  clip: CompiledClip;
  /** ms since the clip's start. */
  clipMs: number;
  /** Song ms of the frame. */
  songMs: number;
  /** Timeline markers (derived + custom), sorted by ms. */
  markers: readonly Marker[];
  /** The frame input the Visualizer's layers and the text layer read (analysis, signals, palette, size, seed…). */
  input: FrameInput;
  /** Evaluates EditParams (keys and marker mods) for this frame. */
  params: ParamContext;
  /** The engine's palette for the clip (visual clips pick theirs). */
  palette: ResolvedPalette;
}

export interface GeneratorInstance {
  /**
   * Draws the clip's picture into `target` (already bound, cleared to
   * transparent, blending off): premultiplied linear colour, full frame,
   * GL's usual bottom-up orientation.
   */
  render(target: Target, f: GeneratorFrame): void;
  resize?(w: number, h: number): void;
  dispose(): void;
}

export type GeneratorKind = "text" | "visual";
export type GeneratorFactory = (ctx: GeneratorContext, clip: CompiledClip) => GeneratorInstance;

const registry = new Map<GeneratorKind, GeneratorFactory>();

export function registerGenerator(kind: GeneratorKind, factory: GeneratorFactory): void {
  registry.set(kind, factory);
}

export function generatorFor(kind: string): GeneratorFactory | undefined {
  return registry.get(kind as GeneratorKind);
}

/** A key that changes when a clip's generator must be rebuilt (kind + its JSON). */
export function generatorKey(c: CompiledClip): string {
  return `${c.id}|${c.kind}|${c.kind === "text" ? JSON.stringify(c.text) : c.kind === "visual" ? `${c.visual?.layer}|${c.visual?.palette}` : ""}`;
}
