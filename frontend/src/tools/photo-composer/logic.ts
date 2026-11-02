import type { ComposerLayer, Composition } from "@/lib/api";
import {
  layerBox,
  rotationFromPointer,
  scaleFromHandle,
  snapMove,
  type Box,
  type Guide,
  type Handle,
  type HandleGeometry,
  type Point,
  type Sizer,
} from "@/composer/hittest";

// Pure geometry for the Photo Composer stage and panels. Everything works in
// document pixels unless a name says "screen".

/** Snap distance on screen. */
export const SNAP_SCREEN_PX = 6;

/** Handle geometry in document pixels for a stage drawn at scale (screen px per doc px). */
export function handleGeometry(scale: number): HandleGeometry {
  const s = scale > 0 ? scale : 1;
  return { radius: 10 / s, rotateOffset: 28 / s };
}

/** The scale that fits a doc into an area (with padding), never below 0.02. */
export function fitScale(availW: number, availH: number, docW: number, docH: number, pad = 32): number {
  if (!(docW > 0) || !(docH > 0)) return 1;
  const s = Math.min((availW - pad) / docW, (availH - pad) / docH);
  return Number.isFinite(s) && s > 0.02 ? s : 0.02;
}

export interface MoveResult {
  patch: Pick<ComposerLayer, "x" | "y">;
  guides: Guide[];
}

/** Moves a layer by (dx, dy) document pixels from its starting box, snapping to the canvas and other layers. */
export function moveWithSnap(
  doc: Composition,
  layer: ComposerLayer,
  start: Box,
  dx: number,
  dy: number,
  sizer: Sizer,
  thresholdDoc: number,
  snap = true,
): MoveResult {
  const moved: Box = { ...start, cx: start.cx + dx, cy: start.cy + dy };
  let sx = 0;
  let sy = 0;
  let guides: Guide[] = [];
  if (snap) {
    const others = (doc.layers ?? []).filter((l) => l.id !== layer.id && !l.hidden).map((l) => layerBox(doc, l, sizer));
    const r = snapMove(doc, moved, others, thresholdDoc);
    sx = r.dx;
    sy = r.dy;
    guides = r.guides;
  }
  return { patch: { x: (moved.cx + sx) / doc.width, y: (moved.cy + sy) / doc.height }, guides };
}

/** Size limits per layer kind (the same ones the model sanitiser applies). */
export function sizeLimits(kind: string): [number, number] {
  return kind === "text" ? [0.005, 1] : [0.005, 5];
}

/** Scales by dragging a corner handle (uniform). */
export function scaleByHandle(
  doc: Pick<Composition, "width" | "height">,
  layer: ComposerLayer,
  start: Box,
  handle: Exclude<Handle, "rotate">,
  p: Point,
  fromCenter: boolean,
): Pick<ComposerLayer, "x" | "y" | "size"> {
  const r = scaleFromHandle(start, handle, p, fromCenter);
  const [lo, hi] = sizeLimits(layer.kind);
  const size = Math.min(hi, Math.max(lo, layer.size * r.factor));
  // If the size was clamped, the centre moves by the same fraction of the way.
  const k = r.factor === 0 ? 1 : size / layer.size / r.factor;
  const cx = fromCenter ? start.cx : start.cx + (r.cx - start.cx) * k;
  const cy = fromCenter ? start.cy : start.cy + (r.cy - start.cy) * k;
  return { x: cx / doc.width, y: cy / doc.height, size };
}

export function rotateByHandle(start: Pick<Box, "cx" | "cy">, p: Point, snap: boolean): number {
  return rotationFromPointer(start, p, snap ? 15 : 0);
}

/** Arrow-key nudge: 1 document px (10 with Shift). */
export function nudge(
  doc: Pick<Composition, "width" | "height">,
  layer: ComposerLayer,
  key: string,
  shift: boolean,
): Pick<ComposerLayer, "x" | "y"> | null {
  const step = shift ? 10 : 1;
  const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
  const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
  if (dx === 0 && dy === 0) return null;
  return { x: layer.x + dx / doc.width, y: layer.y + dy / doc.height };
}

/**
 * Where a dragged row lands, as a position in the list shown top→bottom:
 * the number of other rows whose centre is above y.
 */
export function dropIndex(centers: readonly number[], from: number, y: number): number {
  let n = 0;
  centers.forEach((c, i) => {
    if (i !== from && c < y) n++;
  });
  return n;
}

/** Display index (top = 0) to document layer index (bottom = 0). */
export function displayToDocIndex(count: number, displayIndex: number): number {
  return Math.max(0, Math.min(count - 1, count - 1 - displayIndex));
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** New background pan after dragging the photo by (dx, dy) document pixels. */
export function panBackground(
  doc: Pick<Composition, "width" | "height" | "background">,
  img: { w: number; h: number },
  start: { panX: number; panY: number },
  dx: number,
  dy: number,
): { panX: number; panY: number } {
  const { width: W, height: H } = doc;
  if (!(img.w > 0) || !(img.h > 0)) return start;
  const k = Math.max(W / img.w, H / img.h) * Math.max(1, doc.background.zoom || 1);
  const ox = (img.w * k - W) / 2;
  const oy = (img.h * k - H) / 2;
  return {
    panX: ox > 0.5 ? clamp(start.panX - dx / ox, -1, 1) : start.panX,
    panY: oy > 0.5 ? clamp(start.panY - dy / oy, -1, 1) : start.panY,
  };
}

/** New background zoom for a wheel delta. */
export function zoomBackground(zoom: number, deltaY: number): number {
  return clamp(zoom * Math.exp(-deltaY * 0.0015), 1, 4);
}

/** Layer corners as an SVG points string. */
export function pointsOf(corners: readonly Point[]): string {
  return corners.map((c) => `${round(c.x)},${round(c.y)}`).join(" ");
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Rounds to a number of decimals for number fields. */
export function roundTo(v: number, digits: number): number {
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}

/** True when a layer present in both documents moved, scaled or rotated. */
export function geometryChanged(a: Composition, b: Composition): boolean {
  const before = new Map((a.layers ?? []).map((l) => [l.id, l]));
  for (const l of b.layers ?? []) {
    const o = before.get(l.id);
    if (o && (o.x !== l.x || o.y !== l.y || o.size !== l.size || o.rotation !== l.rotation)) return true;
  }
  return false;
}

/** Client pixels to a position on the canvas as fractions (0..1) of its width and height. */
export function canvasFraction(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0.5, y: 0.5 };
  const c = (v: number): number => Math.min(1, Math.max(0, v));
  return { x: c((clientX - rect.left) / rect.width), y: c((clientY - rect.top) / rect.height) };
}

/** Layer IDs between two layers (inclusive) in the given order. */
export function idRange(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return [b];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** Crop rect of a window (fractions of the picture) centred at (cx, cy). */
export function cropFromWindow(
  win: { w: number; h: number },
  cx: number,
  cy: number,
): { x: number; y: number; w: number; h: number } {
  return { x: clamp(cx - win.w / 2, 0, 1 - win.w), y: clamp(cy - win.h / 2, 0, 1 - win.h), w: win.w, h: win.h };
}
