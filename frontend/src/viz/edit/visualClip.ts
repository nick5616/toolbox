/**
 * Visual clips (Phase 9 Part B, WP-FX5): registers the "visual" generator.
 * A visual clip is one Visualizer layer drawn into the clip's target every
 * frame, with the layer's defaults merged with the clip's params (numbers are
 * EditParams, so keys and marker mods work) and the clip's own palette.
 * Stateful layers (they read their previous frame) are refused: nothing is drawn.
 */
import "../layers";
import { resolvePalette, type ResolvedPalette } from "../palette";
import { layerDef, makeRng, type LayerInstance, type ParamSpec, type ParamValues } from "../layers/registry";
import type { PaletteId } from "../types";
import { registerGenerator, type GeneratorFrame } from "./generated";
import { evalEditParam, type ParamContext } from "./params";
import type { EditParam } from "./types";

export type RawVisualParams = Record<string, EditParam | string | boolean>;
export type MergedVisualParams = Record<string, EditParam | string | boolean>;

const isEditParam = (v: unknown): v is EditParam => typeof v === "number" || (typeof v === "object" && v !== null && typeof (v as { base?: unknown }).base === "number");

/**
 * The layer's defaults overlaid with the clip's params. A raw value of the wrong
 * type for its spec (or an enum value that isn't offered, or an unknown name)
 * is ignored.
 */
export function mergeVisualParams(specs: Readonly<Record<string, ParamSpec>>, raw: Readonly<RawVisualParams>): MergedVisualParams {
  const out: MergedVisualParams = {};
  for (const [name, spec] of Object.entries(specs)) {
    const v = raw[name];
    switch (spec.kind) {
      case "number":
        out[name] = v !== undefined && isEditParam(v) ? v : spec.default;
        break;
      case "color":
        out[name] = typeof v === "string" && v !== "" ? v : spec.default;
        break;
      case "enum":
        out[name] = typeof v === "string" && spec.options.includes(v) ? v : spec.default;
        break;
      case "bool":
        out[name] = typeof v === "boolean" ? v : spec.default;
        break;
    }
  }
  return out;
}

/** Merged params with every number evaluated at this frame (keys at clipMs, mods at songMs). */
export function resolveVisualParams(specs: Readonly<Record<string, ParamSpec>>, raw: Readonly<RawVisualParams>, clipMs: number, songMs: number, ctx: ParamContext | null): ParamValues {
  const merged = mergeVisualParams(specs, raw);
  const out: ParamValues = {};
  for (const [name, spec] of Object.entries(specs)) {
    const v = merged[name];
    if (spec.kind === "number") out[name] = evalEditParam(v as EditParam, spec.min, spec.max, clipMs, songMs, ctx);
    else out[name] = v as string | boolean;
  }
  return out;
}

registerGenerator("visual", (ctx, clip) => {
  const def = clip.visual ? layerDef(clip.visual.layer) : undefined;
  let layer: LayerInstance | null = null;
  if (def && !def.stateful) {
    layer = def.create({
      gl: ctx.gl,
      fullscreen: ctx.fullscreen,
      w: ctx.w,
      h: ctx.h,
      seed: ctx.seed,
      rng: (key) => makeRng(ctx.seed, key),
      textures: { cover: null, image: null, coverAspect: 1, imageAspect: 1 },
      previous: () => null,
    });
  }
  const palettes = new Map<PaletteId, ResolvedPalette>();
  const paletteOf = (id: PaletteId): ResolvedPalette => {
    let p = palettes.get(id);
    if (!p) {
      p = resolvePalette({ mode: "fixed", ids: [id] }, null, 0);
      palettes.set(id, p);
    }
    return p;
  };
  return {
    render(_target, f: GeneratorFrame) {
      const v = f.clip.visual;
      if (!layer || !def || !v) return;
      const gl = ctx.gl;
      const params = resolveVisualParams(def.params, v.params, f.clipMs, f.songMs, f.params);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      layer.render({ ...f.input, params, palette: paletteOf(v.palette), opacity: 1, mode: "overlay" });
      gl.disable(gl.BLEND);
    },
    resize(w, h) {
      layer?.resize?.(w, h);
    },
    dispose() {
      layer?.dispose();
      layer = null;
    },
  };
});
