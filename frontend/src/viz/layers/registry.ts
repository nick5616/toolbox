/**
 * Layer contract and registry (SPEC.md §6.7). A layer type is one file that
 * calls `registerLayer(def)`; `layers/index.ts` imports them all.
 *
 * Determinism (SPEC.md §6.1): no Math.random, Date or performance.now. Use
 * `ctx.rng(key)`, `f.analysis.cum(...)` for accumulated motion, and events in
 * a lookback window ≤ 8 s for spawned things. A layer that reads the previous
 * frame sets `stateful: true`.
 */
import type { Analysis } from "../analysis";
import type { Fullscreen, Program, Target } from "../gl/core";
import type { ResolvedPalette } from "../palette";
import type { Signals } from "../signals";
import type { LayerType } from "../types";

export type ParamSpec =
  | { kind: "number"; label: string; min: number; max: number; default: number; step?: number }
  | { kind: "color"; label: string; default: string } // "c0".."c3" | "accent" | "glow" | "bg" | "#rrggbb"
  | { kind: "enum"; label: string; options: readonly string[]; default: string }
  | { kind: "bool"; label: string; default: boolean };

export type ParamValues = Record<string, number | string | boolean>;

export interface FrameInput {
  tMs: number;
  dtMs: number;
  /** Seconds of "motion time": time scaled by the show's speed. */
  motionSec: number;
  params: ParamValues; // resolved: numbers already modulated
  opacity: number; // 0..1, multiply your output by it
  palette: ResolvedPalette;
  analysis: Analysis;
  signals: Signals;
  w: number;
  h: number;
  seed: number;
  quality: "full" | "draft";
  mode: "opaque" | "overlay";
}

export interface LayerContext {
  gl: WebGL2RenderingContext;
  fullscreen: Fullscreen;
  w: number;
  h: number;
  seed: number;
  /** Deterministic random numbers for a key (PCG-style hash stream). */
  rng(key: string): () => number;
  /** Cover art / background image textures (null when not given). */
  textures: { cover: WebGLTexture | null; image: WebGLTexture | null; coverAspect: number; imageAspect: number };
  /** The previous frame of this layer's scene, for stateful layers (null otherwise). */
  previous(): Target | null;
}

export interface LayerInstance {
  /** Draws into the bound target (premultiplied colour, blend set by the engine). */
  render(f: FrameInput): void;
  resize?(w: number, h: number): void;
  dispose(): void;
}

export interface LayerDef {
  type: LayerType;
  label: string;
  group: "background" | "shape" | "particles" | "accent" | "highway" | "motif";
  icon: string; // lucide name for the Layers tab
  stateful?: boolean;
  params: Record<string, ParamSpec>;
  create(ctx: LayerContext): LayerInstance;
}

const registry = new Map<LayerType, LayerDef>();

export function registerLayer(def: LayerDef): void {
  registry.set(def.type, def);
}
export function layerDef(type: LayerType): LayerDef | undefined {
  return registry.get(type);
}
export function layerDefs(): LayerDef[] {
  return [...registry.values()];
}

/** Sets the palette uniforms declared by GLSL_PALETTE. */
export function setPaletteUniforms(p: Program, pal: ResolvedPalette): void {
  p.f3("u_bg", pal.bg).f3("u_c0", pal.colors[0]).f3("u_c1", pal.colors[1]).f3("u_c2", pal.colors[2]).f3("u_c3", pal.colors[3]).f3("u_accent", pal.accent).f3("u_glow", pal.glow);
}

/** Resolves a color param ("c0".."c3", "accent", "glow", "bg" or #hex → linear RGB). */
export function paletteRef(pal: ResolvedPalette, ref: string, hexToLinear: (h: string) => [number, number, number]): [number, number, number] {
  switch (ref) {
    case "c0":
      return pal.colors[0];
    case "c1":
      return pal.colors[1];
    case "c2":
      return pal.colors[2];
    case "c3":
      return pal.colors[3];
    case "accent":
      return pal.accent;
    case "glow":
      return pal.glow;
    case "bg":
      return pal.bg;
    default:
      return hexToLinear(ref);
  }
}

/** Deterministic PRNG for (seed, key). */
export function makeRng(seed: number, key: string): () => number {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  let s = h >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
