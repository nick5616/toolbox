// Shared set-up for the grid simulations (Reaction-diffusion, Ink bleed): the
// stroke's area, its coverage on a coarse grid, and drawing a scalar field back
// onto the canvas in the current colour.

import type { InputPoint, Rect } from "../engine/types";
import { clamp, colorBytes, currentColor, gridAt, makeImage, pointsBounds, present, rasterizeStroke, simScale, strokeHardness, strokeRadius } from "./common";
import type { LabContext } from "./types";

export interface SimArea {
  rect: Rect;
  scale: number;
  gw: number;
  gh: number;
  /** Stroke coverage 0..1 per grid cell. */
  cover: Float32Array;
}

/** Builds the area from a finished stroke; `margin` canvas px around it let the simulation spread. */
export function buildArea(ctx: LabContext, points: InputPoint[], margin: number): SimArea {
  const radius = strokeRadius(ctx);
  const rect = pointsBounds(points, radius + margin);
  const scale = simScale(rect);
  const g = rasterizeStroke(points, radius, strokeHardness(ctx), rect, scale);
  return { rect, scale, gw: g.w, gh: g.h, cover: g.data };
}

/**
 * Draws alpha(field) in the current colour over the area and presents it.
 * `alpha` maps a grid value (bilinearly interpolated) to 0..1 opacity.
 */
export function drawField(ctx: LabContext, area: SimArea, field: Float32Array, alpha: (v: number, x: number, y: number) => number, final: boolean): boolean {
  const { rect, scale, gw, gh } = area;
  const img = makeImage(rect.w, rect.h);
  const [r, g, b] = colorBytes(currentColor(ctx));
  const ca = currentColor(ctx).a;
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const gx = (x + 0.5) / scale;
      const gy = (y + 0.5) / scale;
      const v = gridAt(field, gw, gh, gx, gy);
      const a = clamp(alpha(v, gx, gy), 0, 1) * ca;
      const k = (y * rect.w + x) * 4;
      img.data[k] = r;
      img.data[k + 1] = g;
      img.data[k + 2] = b;
      img.data[k + 3] = Math.round(a * 255);
    }
  }
  return present(ctx, rect, img, undefined, final);
}
