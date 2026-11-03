/**
 * Pure geometry of the preview overlays (§14.8): the clip's drawn box from its
 * fit and transform, handle maths, snapping, and mask coordinates. Everything
 * is in canvas pixels (the preview's own size) unless a name says otherwise.
 *
 * Conventions (§8.5): the fitted source is centred on the frame; the
 * transform scales it, rotates it (positive = clockwise on screen) and moves
 * it by (x·W, y·H). Mask coordinates are fractions of the clip's drawn rect.
 */

export interface Size {
  w: number;
  h: number;
}
export interface Pt {
  x: number;
  y: number;
}

/** A rotated rectangle: centre, size and clockwise rotation in degrees. */
export interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
}

const RAD = Math.PI / 180;

export function rotatePt(p: Pt, about: Pt, deg: number): Pt {
  const c = Math.cos(deg * RAD);
  const s = Math.sin(deg * RAD);
  const dx = p.x - about.x;
  const dy = p.y - about.y;
  return { x: about.x + dx * c - dy * s, y: about.y + dx * s + dy * c };
}

/**
 * The size a clip's source takes in the frame before the transform: `fill`
 * covers, the fit modes contain, and a clip without a known source (colour
 * clips, a source not read yet) is the whole frame.
 */
export function drawnSize(fit: string, src: Size | null, frame: Size): Size {
  if (!src || src.w <= 0 || src.h <= 0 || frame.w <= 0 || frame.h <= 0) return { w: frame.w, h: frame.h };
  const kx = frame.w / src.w;
  const ky = frame.h / src.h;
  const k = fit === "fill" || fit === "" ? Math.max(kx, ky) : Math.min(kx, ky);
  return { w: src.w * k, h: src.h * k };
}

/** A source's displayed size: width and height swap for quarter-turn rotations. */
export function displaySize(info: { width: number; height: number; rotation?: number }): Size | null {
  if (info.width <= 0 || info.height <= 0) return null;
  const turned = Math.abs(Math.round((info.rotation ?? 0) / 90)) % 2 === 1;
  return turned ? { w: info.height, h: info.width } : { w: info.width, h: info.height };
}

export interface TransformValues {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

/** The drawn box on the canvas for the fitted size and the transform values. */
export function boxFor(drawn: Size, frame: Size, t: TransformValues): Box {
  return { cx: frame.w / 2 + t.x * frame.w, cy: frame.h / 2 + t.y * frame.h, w: drawn.w * t.scale, h: drawn.h * t.scale, rotation: t.rotation };
}

/** A point of the box's own space (origin at its top-left, unrotated, `w`×`h` px) on the canvas. */
export function boxToCanvas(box: Box, local: Pt): Pt {
  return rotatePt({ x: box.cx + local.x - box.w / 2, y: box.cy + local.y - box.h / 2 }, { x: box.cx, y: box.cy }, box.rotation);
}

/** The inverse of boxToCanvas. */
export function canvasToBox(box: Box, p: Pt): Pt {
  const q = rotatePt(p, { x: box.cx, y: box.cy }, -box.rotation);
  return { x: q.x - box.cx + box.w / 2, y: q.y - box.cy + box.h / 2 };
}

export type Corner = "tl" | "tr" | "br" | "bl";
const CORNER_UV: Record<Corner, Pt> = { tl: { x: 0, y: 0 }, tr: { x: 1, y: 0 }, br: { x: 1, y: 1 }, bl: { x: 0, y: 1 } };
export const CORNERS: readonly Corner[] = ["tl", "tr", "br", "bl"];

export function cornerPoint(box: Box, c: Corner): Pt {
  const uv = CORNER_UV[c];
  return boxToCanvas(box, { x: uv.x * box.w, y: uv.y * box.h });
}

/** The rotate handle: above the top edge's middle by `offset` canvas px (in the box's own up direction). */
export function rotateHandle(box: Box, offset: number): { from: Pt; to: Pt } {
  return { from: boxToCanvas(box, { x: box.w / 2, y: 0 }), to: boxToCanvas(box, { x: box.w / 2, y: -offset }) };
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** New uniform scale when a corner is dragged from `start` to `pointer` around the box centre. */
export function scaleFromDrag(startScale: number, centre: Pt, start: Pt, pointer: Pt, min: number, max: number): number {
  const d0 = dist(start, centre);
  if (d0 < 1e-6) return startScale;
  return Math.max(min, Math.min(max, (startScale * dist(pointer, centre)) / d0));
}

/** Clockwise degrees of `p` around `centre` (0 = pointing up). */
export function angleDeg(centre: Pt, p: Pt): number {
  return Math.atan2(p.x - centre.x, -(p.y - centre.y)) / RAD;
}

/** Snaps an angle to the nearest multiple of `step` degrees when within `tol`. */
export function snapAngle(deg: number, step = 45, tol = 3): number {
  const n = Math.round(deg / step) * step;
  return Math.abs(deg - n) <= tol ? n : deg;
}

/** New rotation when the rotate handle is dragged: the start rotation plus the angle swept around the centre. */
export function rotationFromDrag(startRotation: number, centre: Pt, start: Pt, pointer: Pt, snap = true): number {
  let d = angleDeg(centre, pointer) - angleDeg(centre, start);
  d = ((((d + 180) % 360) + 360) % 360) - 180; // shortest way round
  const r = startRotation + d;
  return snap ? snapAngle(r) : r;
}

/** Snaps an offset (a fraction of the frame) to 0, the centre line, within `tol`. */
export function snapCentre(v: number, tol: number): { value: number; snapped: boolean } {
  return Math.abs(v) <= tol ? { value: 0, snapped: true } : { value: v, snapped: false };
}

// ---- masks ----

export interface MaskValues {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

/** A mask point in the box's own px: the centre plus the offset, scaled by the mask's size and rotated about the centre. */
export function maskLocalToBox(m: MaskValues, box: Size, p: Pt): Pt {
  // path points sit in 0..1 of the drawn rect; w/h scale them about the mask centre (x, y)
  const c = { x: m.x * box.w, y: m.y * box.h };
  const q = { x: c.x + (p.x - 0.5) * m.w * box.w, y: c.y + (p.y - 0.5) * m.h * box.h };
  return rotatePt(q, c, m.rotation);
}

/** The inverse of maskLocalToBox. */
export function boxToMaskLocal(m: MaskValues, box: Size, p: Pt): Pt {
  const c = { x: m.x * box.w, y: m.y * box.h };
  const q = rotatePt(p, c, -m.rotation);
  const sw = m.w * box.w;
  const sh = m.h * box.h;
  return { x: sw === 0 ? 0.5 : (q.x - c.x) / sw + 0.5, y: sh === 0 ? 0.5 : (q.y - c.y) / sh + 0.5 };
}

/** The four corners (canvas px) of a rect/ellipse mask, tl tr br bl. */
export function maskCorners(m: MaskValues, box: Box): Pt[] {
  const c = { x: m.x * box.w, y: m.y * box.h };
  const hw = (m.w * box.w) / 2;
  const hh = (m.h * box.h) / 2;
  return [
    { x: c.x - hw, y: c.y - hh },
    { x: c.x + hw, y: c.y - hh },
    { x: c.x + hw, y: c.y + hh },
    { x: c.x - hw, y: c.y + hh },
  ].map((p) => boxToCanvas(box, rotatePt(p, c, m.rotation)));
}

/** w and h (fractions of the drawn rect) for a mask corner dragged to canvas point `p`, keeping the centre. */
export function maskSizeFromCorner(m: MaskValues, box: Box, p: Pt, min = 0.01, max = 2): { w: number; h: number } {
  const c = { x: m.x * box.w, y: m.y * box.h };
  const q = rotatePt(canvasToBox(box, p), c, -m.rotation);
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return { w: clamp((2 * Math.abs(q.x - c.x)) / box.w), h: clamp((2 * Math.abs(q.y - c.y)) / box.h) };
}

/** The mask centre (fractions of the drawn rect) when its body is dragged by `d` canvas px from the start centre. */
export function maskCentreFromDrag(start: { x: number; y: number }, box: Box, d: Pt): { x: number; y: number } {
  const r = rotatePt(d, { x: 0, y: 0 }, -box.rotation);
  return { x: start.x + r.x / box.w, y: start.y + r.y / box.h };
}

/** The point on the closed polygon's edge nearest to `p`: which edge (insert after `index`), where, and how far. */
export function nearestEdge(poly: readonly Pt[], p: Pt): { index: number; point: Pt; distance: number } | null {
  let best: { index: number; point: Pt; distance: number } | null = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Pt;
    const b = poly[(i + 1) % poly.length] as Pt;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const point = { x: a.x + t * dx, y: a.y + t * dy };
    const d = dist(p, point);
    if (!best || d < best.distance) best = { index: i, point, distance: d };
  }
  return best;
}

// ---- safe zones ----

export const SAFE_ZONE = { top: 0.1, bottom: 0.22, right: 0.14, left: 0.06 } as const;

export interface ZoneRect {
  id: "top" | "bottom" | "left" | "right";
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The shaded edge bands for a preview of the given size (9:16 and 4:5 only; none for other aspects). */
export function safeZones(aspect: string, w: number, h: number): ZoneRect[] {
  if (aspect !== "9:16" && aspect !== "4:5") return [];
  const top = h * SAFE_ZONE.top;
  const bottom = h * SAFE_ZONE.bottom;
  const left = w * SAFE_ZONE.left;
  const right = w * SAFE_ZONE.right;
  return [
    { id: "top", label: "Top 10%", x: 0, y: 0, w, h: top },
    { id: "bottom", label: "Bottom 22%", x: 0, y: h - bottom, w, h: bottom },
    { id: "left", label: "Left 6%", x: 0, y: top, w: left, h: h - top - bottom },
    { id: "right", label: "Right 14%", x: w - right, y: top, w: right, h: h - top - bottom },
  ];
}

/**
 * The part of an unrotated box inside the frame (fill-mode clips are larger
 * than the frame, so their handles would sit off the preview). Rotated boxes
 * are returned as they are.
 */
export function visibleBox(box: Box, frame: Size): Box {
  if (Math.abs(box.rotation % 360) > 0.01) return box;
  const x0 = Math.max(0, box.cx - box.w / 2);
  const x1 = Math.min(frame.w, box.cx + box.w / 2);
  const y0 = Math.max(0, box.cy - box.h / 2);
  const y1 = Math.min(frame.h, box.cy + box.h / 2);
  if (x1 <= x0 || y1 <= y0) return box;
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, rotation: 0 };
}
