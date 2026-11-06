// Crop planning for perception requests (SPEC §1.4.2 "Crops"). Pure functions.
//
// A request sends only the region: the mask's bounding box plus a margin of
// max(64 px, 50% of the bigger bbox side) on every side, squared and clamped
// to the canvas. Context over the clamp is handled per quality:
//   - Fast fill: above 1536 px the context is downscaled to 1536 (the model is small).
//   - Best fill: passed through at full size (the engine crops at 512 itself).
//   - Anything above 3072 px (enhance: 1024) is split into overlapping tiles
//     that run one after another and are blended with edge ramps.

import type { Rect } from "../engine/types";

export const MIN_MARGIN = 64;
export const FAST_CLAMP = 1536;
export const BEST_CLAMP = 3072;
export const ENHANCE_TILE = 1024;
export const TILE_OVERLAP = 64;
export const FEATHER_PX = 4;

export type AIQuality = "fast" | "best";

export function marginFor(bounds: Rect): number {
  return Math.max(MIN_MARGIN, Math.round(Math.max(bounds.w, bounds.h) * 0.5));
}

/** The square (when the canvas allows) crop around a mask bbox, clamped to the canvas. */
export function cropRectFor(bounds: Rect, canvasW: number, canvasH: number): Rect {
  const side = Math.max(bounds.w, bounds.h) + 2 * marginFor(bounds);
  const axis = (start: number, len: number, dim: number): [number, number] => {
    const size = Math.min(side, dim);
    const centre = start + len / 2;
    const s = Math.min(Math.max(0, Math.round(centre - size / 2)), dim - size);
    return [s, size];
  };
  const [x, w] = axis(bounds.x, bounds.w, canvasW);
  const [y, h] = axis(bounds.y, bounds.h, canvasH);
  return { x, y, w, h };
}

export interface CropLimits {
  /** Context larger than this is downscaled to it (null = never). */
  downscaleAbove: number | null;
  /** Context larger than this is split into tiles. */
  tileAbove: number;
}

export type AIOpName = "fill" | "cutout" | "segment" | "enhance";

export function limitsFor(op: AIOpName, quality: AIQuality): CropLimits {
  switch (op) {
    case "fill":
      return quality === "fast" ? { downscaleAbove: FAST_CLAMP, tileAbove: BEST_CLAMP } : { downscaleAbove: null, tileAbove: BEST_CLAMP };
    case "enhance":
      return { downscaleAbove: null, tileAbove: ENHANCE_TILE };
    default:
      // Cut-out and segmentation can't be stitched: one call, downscaled when huge.
      return { downscaleAbove: BEST_CLAMP, tileAbove: Number.POSITIVE_INFINITY };
  }
}

/** Splits `r` into overlapping tiles no bigger than `max` per side (one tile when it fits). */
export function planTiles(r: Rect, max: number, overlap = TILE_OVERLAP): Rect[] {
  const split = (start: number, len: number): Array<[number, number]> => {
    if (len <= max) return [[start, len]];
    const step = max - overlap;
    const n = Math.ceil((len - overlap) / step);
    const size = Math.ceil((len + (n - 1) * overlap) / n); // equal tiles
    const out: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
      const s = i === n - 1 ? start + len - size : start + i * (size - overlap);
      out.push([s, size]);
    }
    return out;
  };
  const xs = split(r.x, r.w);
  const ys = split(r.y, r.h);
  const tiles: Rect[] = [];
  for (const [y, h] of ys) for (const [x, w] of xs) tiles.push({ x, y, w, h });
  return tiles;
}

export interface TilePlan {
  /** Canvas px. */
  rect: Rect;
  /** Size actually sent to the engine (≤ rect when downscaled). */
  sendW: number;
  sendH: number;
}

export interface CropPlan {
  /** The whole context crop, canvas px. */
  rect: Rect;
  tiles: TilePlan[];
}

export function planCrop(bounds: Rect, canvasW: number, canvasH: number, op: AIOpName, quality: AIQuality): CropPlan {
  const rect = cropRectFor(bounds, canvasW, canvasH);
  const lim = limitsFor(op, quality);
  const rects = Math.max(rect.w, rect.h) > lim.tileAbove ? planTiles(rect, lim.tileAbove) : [rect];
  const tiles = rects.map((t): TilePlan => {
    const big = Math.max(t.w, t.h);
    if (lim.downscaleAbove !== null && big > lim.downscaleAbove) {
      const k = lim.downscaleAbove / big;
      return { rect: t, sendW: Math.max(1, Math.round(t.w * k)), sendH: Math.max(1, Math.round(t.h * k)) };
    }
    return { rect: t, sendW: t.w, sendH: t.h };
  });
  return { rect, tiles };
}

/**
 * Blend weight (0..1) of a tile at each of its pixels: a linear ramp over the
 * overlap on every edge that borders another tile, 1 elsewhere (crop edges).
 */
export function tileWeights(tile: Rect, crop: Rect, overlap = TILE_OVERLAP): Float32Array {
  const w = new Float32Array(tile.w * tile.h);
  const left = tile.x > crop.x;
  const top = tile.y > crop.y;
  const right = tile.x + tile.w < crop.x + crop.w;
  const bottom = tile.y + tile.h < crop.y + crop.h;
  const ramp = (i: number, len: number, lo: boolean, hi: boolean): number => {
    let v = 1;
    if (lo && i < overlap) v = Math.min(v, (i + 0.5) / overlap);
    if (hi && len - 1 - i < overlap) v = Math.min(v, (len - 1 - i + 0.5) / overlap);
    return v;
  };
  for (let y = 0; y < tile.h; y++) {
    const wy = ramp(y, tile.h, top, bottom);
    for (let x = 0; x < tile.w; x++) w[y * tile.w + x] = Math.min(wy, ramp(x, tile.w, left, right));
  }
  return w;
}

/** Union of two rects. */
export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
}
