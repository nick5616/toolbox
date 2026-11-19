/** Pure maths of the crop overlay (Phase 21 SPEC §B4): crop edges from pointer positions, and the edge handles' places. */
import { boxToCanvas, canvasToBox, type Box, type Pt, type Size } from "./overlayGeometry";

export type CropEdge = "l" | "r" | "t" | "b";
export type CropValues = Record<CropEdge, number>;

export const CROP_MAX = 0.45;

/** The corners' two edges: Alt+drag on a scale corner handle crops both. */
export const CORNER_EDGES: Record<"tl" | "tr" | "br" | "bl", [CropEdge, CropEdge]> = {
  tl: ["l", "t"],
  tr: ["r", "t"],
  br: ["r", "b"],
  bl: ["l", "b"],
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The crop (fraction of the picture, 0..0.45) one edge gets when it is dragged to canvas point `p`. */
export function cropEdgeFromPoint(box: Box, p: Pt, edge: CropEdge): number {
  const q = canvasToBox(box, p);
  const f = edge === "l" ? q.x / box.w : edge === "r" ? 1 - q.x / box.w : edge === "t" ? q.y / box.h : 1 - q.y / box.h;
  return clamp(f, 0, CROP_MAX);
}

/** The handle of an edge on the canvas: on the crop line, halfway along the kept part (nudged into the frame). */
export function cropHandlePoint(box: Box, crop: CropValues, edge: CropEdge, frame?: Size, inset = 10): Pt {
  const mx = ((crop.l + 1 - crop.r) / 2) * box.w;
  const my = ((crop.t + 1 - crop.b) / 2) * box.h;
  const local: Pt =
    edge === "l" ? { x: crop.l * box.w, y: my } : edge === "r" ? { x: (1 - crop.r) * box.w, y: my } : edge === "t" ? { x: mx, y: crop.t * box.h } : { x: mx, y: (1 - crop.b) * box.h };
  const p = boxToCanvas(box, local);
  return frame ? { x: clamp(p.x, inset, Math.max(inset, frame.w - inset)), y: clamp(p.y, inset, Math.max(inset, frame.h - inset)) } : p;
}

/** The four corners (canvas px) of the kept rectangle, tl tr br bl. */
export function cropCorners(box: Box, crop: CropValues): Pt[] {
  const l = crop.l * box.w;
  const r = (1 - crop.r) * box.w;
  const t = crop.t * box.h;
  const b = (1 - crop.b) * box.h;
  return [
    { x: l, y: t },
    { x: r, y: t },
    { x: r, y: b },
    { x: l, y: b },
  ].map((pt) => boxToCanvas(box, pt));
}
