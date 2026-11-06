// Tip and grain images. A preset names them as "lib:<file>" (bundled, B1's
// library) or "set:<setId>/<file>" (user/imported, PaintService.BrushAsset);
// both come through one resolver function the host passes to the engine.

import type { DabStyle, GLBackend, MaskTex, TipStyle } from "../engine/gl";
import type { BrushPreset, Tip } from "./schema";

/** Straight RGBA pixels of a tip or grain image. */
export interface AssetImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Resolves "lib:<file>" / "set:<id>/<file>" to pixels (null = missing). */
export type AssetResolver = (ref: string) => Promise<AssetImage | null> | AssetImage | null;

/** White paints: coverage = luminance × alpha. */
export function toMask(img: AssetImage): Uint8Array {
  const out = new Uint8Array(img.width * img.height);
  const d = img.data;
  for (let i = 0; i < out.length; i++) {
    const r = d[i * 4] as number;
    const g = d[i * 4 + 1] as number;
    const b = d[i * 4 + 2] as number;
    const a = d[i * 4 + 3] as number;
    out[i] = Math.round(((0.3 * r + 0.59 * g + 0.11 * b) * a) / 255);
  }
  return out;
}

const isImageRef = (s: string) => s.startsWith("lib:") || s.startsWith("set:");

export class BrushAssets {
  private readonly cache = new Map<string, MaskTex | null>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly backend: () => GLBackend,
    private resolver: AssetResolver | null,
  ) {}

  setResolver(r: AssetResolver | null): void {
    this.resolver = r;
  }

  /** Load every image a preset uses; draw calls then find them synchronously. */
  async prepare(p: BrushPreset): Promise<void> {
    const refs: string[] = [];
    if (isImageRef(p.tip.shape)) refs.push(p.tip.shape);
    if (p.dual && isImageRef(p.dual.shape)) refs.push(p.dual.shape);
    if (p.grain.texture) refs.push(p.grain.texture);
    await Promise.all(refs.map((r) => this.load(r)));
  }

  private load(ref: string): Promise<void> {
    if (this.cache.has(ref)) return Promise.resolve();
    let pr = this.pending.get(ref);
    if (!pr) {
      pr = (async () => {
        let tex: MaskTex | null = null;
        try {
          const img = this.resolver ? await this.resolver(ref) : null;
          if (img && img.width > 0 && img.height > 0) tex = this.backend().createMask(toMask(img), img.width, img.height);
        } catch {
          tex = null;
        }
        this.cache.set(ref, tex);
        this.pending.delete(ref);
      })();
      this.pending.set(ref, pr);
    }
    return pr;
  }

  /** Register a texture directly (tests, procedurally made tips). */
  put(ref: string, data: Uint8Array, w: number, h: number): void {
    this.cache.set(ref, this.backend().createMask(data, w, h));
  }

  private tip(t: Tip): TipStyle {
    if (t.shape === "round" || t.shape === "square") return { shape: t.shape, tex: null, hardness: t.hardness, invert: t.invert };
    const tex = this.cache.get(t.shape) ?? null;
    if (!tex) {
      // Not loaded (yet) or missing: a round tip, and start loading it.
      if (isImageRef(t.shape)) void this.load(t.shape);
      return { shape: "round", tex: null, hardness: t.hardness, invert: false };
    }
    return { shape: "image", tex, hardness: t.hardness, invert: t.invert };
  }

  style(p: BrushPreset, coverageOnly: boolean): DabStyle {
    const gtex = p.grain.texture ? (this.cache.get(p.grain.texture) ?? null) : null;
    if (p.grain.texture && !this.cache.has(p.grain.texture)) void this.load(p.grain.texture);
    return {
      tip: this.tip(p.tip),
      dual: p.dual ? { ...this.tip(p.dual), roundness: p.dual.roundness } : null,
      grain: gtex
        ? { tex: gtex, texturised: p.grain.mode === "texturised", scale: Math.max(0.05, p.grain.scale), depth: p.grain.depth, contrast: p.grain.contrast }
        : null,
      antialias: p.antialias,
      rendering: p.rendering === "uniform-glaze" ? 1 : p.rendering === "intense" ? 2 : 0,
      coverageOnly,
    };
  }

  dispose(): void {
    for (const t of this.cache.values()) if (t) this.backend().destroyMask(t);
    this.cache.clear();
  }
}
