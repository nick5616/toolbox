/**
 * Preview point → clip source UV (Phase 21 SPEC §B4, the key eyedropper). The
 * inverse of the drawing: the transform (centre offset, scale, rotation), then
 * the fit and the crop, then the flip. Pure.
 */
import { boxFor, canvasToBox, type Pt, type Size } from "./overlayGeometry";

export interface SourcePointInput {
  /** Canvas pixels. */
  point: Pt;
  frame: Size;
  /** The picture's size before the transform (`drawnSize`). */
  drawn: Size;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  /** Crop l, r, t, b (fractions of the picture). */
  crop?: readonly [number, number, number, number];
  flipX?: boolean;
}

/**
 * The (u, v) in the clip's source picture (0..1, origin top-left, flip applied)
 * under a preview point, or null when it is outside the picture or inside the crop.
 */
export function previewToSourceUV(i: SourcePointInput): { u: number; v: number } | null {
  const box = boxFor(i.drawn, i.frame, { x: i.x, y: i.y, scale: i.scale, rotation: i.rotation });
  if (box.w <= 0 || box.h <= 0) return null;
  const local = canvasToBox(box, i.point);
  const ru = local.x / box.w;
  const rv = local.y / box.h;
  if (ru < 0 || ru > 1 || rv < 0 || rv > 1) return null;
  const c = i.crop ?? [0, 0, 0, 0];
  if (ru < c[0] || ru > 1 - c[1] || rv < c[2] || rv > 1 - c[3]) return null;
  return { u: i.flipX ? 1 - ru : ru, v: rv };
}

/** The inverse, for tests and for drawing a marker: a source UV → canvas point. */
export function sourceUVToPreview(i: Omit<SourcePointInput, "point">, uv: { u: number; v: number }): Pt {
  const ru = i.flipX ? 1 - uv.u : uv.u;
  const box = boxFor(i.drawn, i.frame, { x: i.x, y: i.y, scale: i.scale, rotation: i.rotation });
  const cx = box.cx - box.w / 2 + ru * box.w;
  const cy = box.cy - box.h / 2 + uv.v * box.h;
  const dx = cx - box.cx;
  const dy = cy - box.cy;
  const r = (i.rotation * Math.PI) / 180;
  return { x: box.cx + dx * Math.cos(r) - dy * Math.sin(r), y: box.cy + dx * Math.sin(r) + dy * Math.cos(r) };
}
