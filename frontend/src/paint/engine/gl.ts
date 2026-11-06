// The GPU abstraction (SPEC §5 "GL"): the engine talks to a GLBackend, never to
// WebGL directly. glBackend.ts is the WebGL2 implementation; cpuBackend.ts is
// the reference used by vitest (jsdom has no WebGL). Both produce the same
// pixels within a small tolerance for normal blending and basic dabs.
//
// Every Surface is a TILE×TILE premultiplied RGBA8 target (tiles, scratch,
// temporaries). Pixel coordinates are y-down everywhere; nothing is flipped.

export const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "add",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "soft-light",
  "hard-light",
  "difference",
  "hue",
  "saturation",
  "color",
  "luminosity",
] as const;

export function blendId(mode: string): number {
  const i = (BLEND_MODES as readonly string[]).indexOf(mode);
  return i < 0 ? 0 : i;
}

/** A tile-sized render target / texture. Opaque to the engine. */
export interface Surface {
  readonly w: number;
  readonly h: number;
}

/** A single-channel (0..1) texture for tip and grain images. */
export interface MaskTex {
  readonly w: number;
  readonly h: number;
}

/** Floats per dab in a DabBatch. */
export const DAB_STRIDE = 20;
/** Field offsets in a dab. */
export const D = {
  X: 0,
  Y: 1,
  SIZE: 2,
  ANGLE: 3, // radians
  ROUND: 4,
  ALPHA: 5, // flow × opacity dynamics, before grain
  R: 6,
  G: 7,
  B: 8,
  GX: 9, // moving-grain offset (px)
  GY: 10,
  DANGLE: 11, // dual tip angle relative to the dab (radians)
  DSCALE: 12, // dual tip size relative to the dab
  WET: 13, // wet-mix amount 0..1
  PULLX: 14, // wet pull: offset of the sampled canvas pixel
  PULLY: 15,
} as const;

export interface DabBatch {
  data: Float32Array;
  /** Dab index range [start, end). */
  start: number;
  end: number;
}

export interface TipStyle {
  /**
   * "image" is a grayscale coverage mask; "color" is a full-colour (RGBA) tip such as a
   * subject stamp: it paints its own colours, and `hardness` is then the tint: 0 keeps the
   * tip's colours, 1 paints its silhouette in the current colour.
   */
  shape: "round" | "square" | "image" | "color";
  tex: MaskTex | null;
  hardness: number;
  invert: boolean;
}

export interface DabStyle {
  tip: TipStyle;
  dual: (TipStyle & { roundness: number }) | null;
  grain: { tex: MaskTex | null; texturised: boolean; scale: number; depth: number; contrast: number } | null;
  /** false: nearest-neighbour, no edge smoothing (pixel brushes). */
  antialias: boolean;
  /** 0 light glaze (over), 1 uniform glaze (max), 2 intense (steeper alpha). */
  rendering: 0 | 1 | 2;
  /** Output alpha only (eraser, history brush, mask strokes). */
  coverageOnly: boolean;
}

export type MergeOp = "over" | "atop" | "erase" | "revert";

export interface MergeParams {
  op: MergeOp;
  mode: number;
  /** The stroke's opacity. */
  opacity: number;
  wetEdges: number;
  impasto: number;
  /** Per-tile selection alpha, or null. */
  selection: Surface | null;
  /** Source tile for op "revert" (History brush). */
  source: Surface | null;
}

export interface BlendParams {
  mode: number;
  opacity: number;
  /** Keep the destination's alpha (clipping masks): source only tints what's there. */
  atop?: boolean;
}

export interface PresentArgs {
  canvas: HTMLCanvasElement;
  /** Viewport in CSS px; the backing store may be larger (DPR). */
  cssW: number;
  cssH: number;
  /** Canvas px → CSS px: [a, b, c, d, e, f] with x' = a x + c y + e, y' = b x + d y + f. */
  matrix: [number, number, number, number, number, number];
  docW: number;
  docH: number;
  checker: boolean;
  nearest: boolean;
}

export interface GLBackend {
  readonly name: "webgl2" | "cpu";
  /** The WebGL2 context (Lab shader tools); null on the CPU backend. */
  readonly gl: WebGL2RenderingContext | null;
  readonly tile: number;

  createSurface(): Surface;
  destroySurface(s: Surface): void;
  /** Transparent. */
  clear(s: Surface): void;
  /** Solid premultiplied colour, bytes 0..255. */
  fill(s: Surface, r: number, g: number, b: number, a: number): void;
  copy(dst: Surface, src: Surface): void;
  /** Write premultiplied RGBA8 `data` (w×h) at (x, y). */
  upload(s: Surface, data: Uint8ClampedArray, x: number, y: number, w: number, h: number): void;
  /** Read premultiplied RGBA8 of a sub-rectangle. */
  download(s: Surface, x: number, y: number, w: number, h: number): Uint8ClampedArray;

  createMask(data: Uint8Array | Uint8ClampedArray, w: number, h: number): MaskTex;
  /** A colour tip: straight (non-premultiplied) RGBA8, w×h. Freed with destroyMask. */
  createColorMask(rgba: Uint8ClampedArray, w: number, h: number): MaskTex;
  destroyMask(m: MaskTex): void;

  /**
   * Draw dabs into `dst` (a tile whose top-left is canvas (ox, oy)), clipped to
   * `clip` (canvas px; the canvas bounds). `source` is sampled for wet mix.
   */
  drawDabs(
    dst: Surface,
    ox: number,
    oy: number,
    batch: DabBatch,
    style: DabStyle,
    source: Surface | null,
    clip: { x: number; y: number; w: number; h: number },
  ): void;
  /** Merge a stroke's scratch tile into a layer tile. */
  mergeScratch(layer: Surface, scratch: Surface, p: MergeParams): void;
  /** Compositor primitive: dst = blend(dst, src). */
  blend(dst: Surface, src: Surface, p: BlendParams): void;
  /** Selection tile: alpha = mask bytes (w×h) at (x, y); other texels untouched. */
  uploadAlpha(s: Surface, mask: Uint8Array, x: number, y: number, w: number, h: number): void;

  /** The flattened canvas, kept as one texture so the view never shows tile seams. */
  resizeComposite(w: number, h: number): void;
  storeComposite(tile: Surface, x: number, y: number, w: number, h: number): void;
  readComposite(): Uint8ClampedArray;
  present(args: PresentArgs): void;
  dispose(): void;
}
