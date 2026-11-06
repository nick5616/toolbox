// Mask builders for the perception tools. Pure functions over ImageData-like
// masks (the alpha channel is the mask). Everything is deterministic.

import type { Rect } from "../engine/types";
import { alphaOf, createImage, maskFromAlpha, morph } from "./pixels";

export const BAND = 512;

/** The ring of `mask` that is at most `width` px deep: mask minus the mask eroded by width. */
export function ringMask(mask: ImageData, width: number): ImageData {
  const w = mask.width;
  const h = mask.height;
  const a = alphaOf(mask);
  // Pad by one pixel of zero so masks touching the border still erode from the border.
  const inner = morph(a, w, h, -Math.max(1, Math.round(width)));
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.max(0, a[i]! - inner[i]!);
  return maskFromAlpha(out, w, h);
}

export type DriftDir = "" | "down" | "up" | "left" | "right";

export interface FillFields {
  passes: number;
  ghost: number;
  drift: number;
  driftDir: DriftDir;
  offset: [number, number];
  model: "fast" | "best";
}

export const FILL_DEFAULTS: FillFields = { passes: 1, ghost: 0, drift: 0, driftDir: "", offset: [0, 0], model: "best" };

export interface FillSetup {
  mask: ImageData;
  fields: FillFields;
}

function num(p: Record<string, number | string | boolean>, k: string, d: number): number {
  const v = p[k];
  return typeof v === "number" ? v : d;
}
function str(p: Record<string, number | string | boolean>, k: string, d: string): string {
  const v = p[k];
  return typeof v === "string" ? v : d;
}

/** Turns a stroke mask and a fill tool's params into the mask to send and the request fields. */
export function buildFill(toolId: string, stroke: ImageData, params: Record<string, number | string | boolean>): FillSetup {
  const model = str(params, "quality", "best") === "fast" ? "fast" : "best";
  const base: FillFields = { ...FILL_DEFAULTS, model };
  switch (toolId) {
    case "fill-eraser":
      return { mask: stroke, fields: base };
    case "dissolve":
      return {
        mask: stroke,
        fields: {
          ...base,
          passes: clampInt(num(params, "passes", 4), 1, 12),
          ghost: clamp01(num(params, "ghost", 0)),
          drift: clamp01(num(params, "drift", 0)),
        },
      };
    case "melt": {
      const dir = str(params, "direction", "down");
      return {
        mask: stroke,
        fields: {
          ...base,
          passes: clampInt(num(params, "passes", 6), 1, 12),
          ghost: clamp01(num(params, "ghost", 0)),
          drift: clamp01(num(params, "drift", 0)),
          driftDir: dir === "up" || dir === "left" || dir === "right" ? dir : "down",
        },
      };
    }
    case "echo-fill":
      return {
        mask: stroke,
        fields: { ...base, offset: [Math.round(num(params, "offsetX", 24)), Math.round(num(params, "offsetY", 0))] },
      };
    case "edge-erode":
      return { mask: ringMask(stroke, num(params, "width", 8)), fields: base };
    default:
      throw new Error(`Unknown fill tool: ${toolId}`);
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface BandStep {
  /** Canvas px in the resized canvas. */
  bounds: Rect;
  /** Fully opaque mask over `bounds`. */
  mask: ImageData;
}

/** Opaque mask of a rect. */
export function solidMask(w: number, h: number): ImageData {
  const out = createImage(w, h);
  out.data.fill(255);
  return out;
}

/**
 * The new margins of a grown canvas as fill steps in BAND-px bands, in the
 * order they should run: left and right (old height) outward, then top and
 * bottom outward across the full new width, so corners are filled from bands
 * that already exist. Each new pixel is in exactly one band.
 */
export function extendBands(oldW: number, oldH: number, m: Margins): BandStep[] {
  const newW = oldW + m.left + m.right;
  const rects: Rect[] = [];
  // `off` counts px away from the original edge.
  const outward = (size: number, make: (off: number, len: number) => Rect) => {
    for (let off = 0; off < size; off += BAND) rects.push(make(off, Math.min(BAND, size - off)));
  };
  outward(m.left, (off, len) => ({ x: m.left - off - len, y: m.top, w: len, h: oldH }));
  outward(m.right, (off, len) => ({ x: m.left + oldW + off, y: m.top, w: len, h: oldH }));
  outward(m.top, (off, len) => ({ x: 0, y: m.top - off - len, w: newW, h: len }));
  outward(m.bottom, (off, len) => ({ x: 0, y: m.top + oldH + off, w: newW, h: len }));
  return rects.filter((r) => r.w > 0 && r.h > 0).map((r) => ({ bounds: r, mask: solidMask(r.w, r.h) }));
}

/** Which anchor of the resized canvas keeps the old pixels (0..1 on each axis) for the given margins. */
export function anchorFor(m: Margins): { x: number; y: number } {
  const dw = m.left + m.right;
  const dh = m.top + m.bottom;
  return { x: dw === 0 ? 0 : m.left / dw, y: dh === 0 ? 0 : m.top / dh };
}
