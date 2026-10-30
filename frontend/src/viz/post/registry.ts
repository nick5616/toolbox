/**
 * Post effects (SPEC.md §6.7 post list). "output" effects (bloom, vignette,
 * grain) feed the fixed output pass; "pass" effects run HDR → HDR, in a
 * scene's chain or the global chain, before the output.
 */
import type { Fullscreen, Target } from "../gl/core";
import type { FrameInput, ParamSpec } from "../layers/registry";
import type { PostType } from "../types";

export interface PostContext {
  gl: WebGL2RenderingContext;
  fullscreen: Fullscreen;
  w: number;
  h: number;
  seed: number;
}

export interface PostInstance {
  /** Reads input, writes output (both HDR, same size). */
  render(input: Target, output: Target, f: FrameInput): void;
  resize?(w: number, h: number): void;
  dispose(): void;
}

export interface PostDef {
  type: PostType;
  label: string;
  kind: "output" | "pass";
  stateful?: boolean;
  params: Record<string, ParamSpec>;
  create?(ctx: PostContext): PostInstance;
}

const registry = new Map<PostType, PostDef>();
export function registerPost(def: PostDef): void {
  registry.set(def.type, def);
}
export function postDef(type: PostType): PostDef | undefined {
  return registry.get(type);
}
export function postDefs(): PostDef[] {
  return [...registry.values()];
}

registerPost({
  type: "bloom",
  label: "Bloom",
  kind: "output",
  params: {
    intensity: { kind: "number", label: "Intensity", min: 0, max: 2, default: 0.8 },
    threshold: { kind: "number", label: "Threshold", min: 0.3, max: 2, default: 0.8 },
  },
});
registerPost({
  type: "vignette",
  label: "Vignette",
  kind: "output",
  params: { amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0.35 } },
});
registerPost({
  type: "grain",
  label: "Film grain",
  kind: "output",
  params: { amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0.15 } },
});
