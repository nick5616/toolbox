/**
 * The text layer (SPEC.md §6.8). CONTRACT (foundation): the engine calls
 * `createTextLayer` once and `render` per frame after the scenes and before
 * the global post chain. TX1 implements it (atlas, layout, animations).
 */
import type { Fullscreen } from "../gl/core";
import type { FrameInput } from "../layers/registry";
import type { TextStyle } from "../types";

export interface TextLayer {
  /** Draws the words at f.tMs into the bound HDR target. */
  render(f: FrameInput, style: TextStyle): void;
  resize(w: number, h: number): void;
  dispose(): void;
}

export interface TextLayerContext {
  gl: WebGL2RenderingContext;
  fullscreen: Fullscreen;
  w: number;
  h: number;
  /** True in a worker (OffscreenCanvas 2D for rasterising). */
  inWorker: boolean;
}

export function createTextLayer(_ctx: TextLayerContext): TextLayer {
  return { render() {}, resize() {}, dispose() {} };
}
