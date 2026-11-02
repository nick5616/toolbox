import type { ComposerLayer, Composition } from "@/lib/api";

// Geometry for the stage (SPEC.md Part B §B5.5): where a layer is on the
// canvas, what a click hits, which handle is under the pointer, and snapping.
// Everything is in canvas pixels at scale 1 (doc.width × doc.height); the
// stage converts screen pixels to canvas pixels before calling in.

export interface Point {
  x: number;
  y: number;
}

/** A rotated rectangle: centre, size and clockwise rotation in degrees. */
export interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
}

/** A layer's unrotated size in canvas pixels (see render.ts layerSize). */
export type Sizer = (layer: ComposerLayer) => { w: number; h: number };

export function layerBox(doc: Pick<Composition, "width" | "height">, layer: ComposerLayer, sizer: Sizer): Box {
  const { w, h } = sizer(layer);
  return { cx: layer.x * doc.width, cy: layer.y * doc.height, w, h, rot: layer.rotation };
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Rotates v around the origin by deg (clockwise on screen, y down). */
function rotate(v: Point, deg: number): Point {
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** Corners in order top-left, top-right, bottom-right, bottom-left (before rotation naming). */
export function boxCorners(b: Box): [Point, Point, Point, Point] {
  const hw = b.w / 2;
  const hh = b.h / 2;
  const at = (x: number, y: number): Point => {
    const r = rotate({ x, y }, b.rot);
    return { x: b.cx + r.x, y: b.cy + r.y };
  };
  return [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)];
}

/** The axis-aligned bounds of a rotated box. */
export function boxBounds(b: Box): { left: number; top: number; right: number; bottom: number } {
  const cs = boxCorners(b);
  const xs = cs.map((p) => p.x);
  const ys = cs.map((p) => p.y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/** Converts a canvas point into the box's own (unrotated, centre-origin) space. */
export function toLocal(b: Box, p: Point): Point {
  return rotate({ x: p.x - b.cx, y: p.y - b.cy }, -b.rot);
}

export function pointInBox(b: Box, p: Point, pad = 0): boolean {
  const l = toLocal(b, p);
  return Math.abs(l.x) <= b.w / 2 + pad && Math.abs(l.y) <= b.h / 2 + pad;
}

export interface HitOptions {
  /** Also hit locked layers (default: locked layers are only selectable from the panel). */
  includeLocked?: boolean;
  /** Extra tolerance in canvas px. */
  pad?: number;
}

/** The topmost visible layer under p, or null. */
export function hitLayer(doc: Composition, p: Point, sizer: Sizer, opts: HitOptions = {}): ComposerLayer | null {
  const layers = doc.layers ?? [];
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i] as ComposerLayer;
    if (l.hidden || (l.locked && !opts.includeLocked)) continue;
    if (pointInBox(layerBox(doc, l, sizer), p, opts.pad ?? 0)) return l;
  }
  return null;
}

export type Handle = "nw" | "ne" | "se" | "sw" | "rotate";

export interface HandleGeometry {
  /** Handle hit radius in canvas px. */
  radius: number;
  /** Distance of the rotate handle above the top edge, canvas px. */
  rotateOffset: number;
}

export const DEFAULT_HANDLES: HandleGeometry = { radius: 10, rotateOffset: 28 };

/** Positions of the four corner handles and the rotate handle. */
export function handlePositions(b: Box, g: HandleGeometry = DEFAULT_HANDLES): Record<Handle, Point> {
  const [nw, ne, se, sw] = boxCorners(b);
  const r = rotate({ x: 0, y: -(b.h / 2 + g.rotateOffset) }, b.rot);
  return { nw, ne, se, sw, rotate: { x: b.cx + r.x, y: b.cy + r.y } };
}

/** The handle under p (the rotate handle wins over a corner when they overlap). */
export function hitHandle(b: Box, p: Point, g: HandleGeometry = DEFAULT_HANDLES): Handle | null {
  const pos = handlePositions(b, g);
  const order: Handle[] = ["rotate", "nw", "ne", "se", "sw"];
  for (const h of order) {
    const q = pos[h];
    if (Math.hypot(p.x - q.x, p.y - q.y) <= g.radius) return h;
  }
  return null;
}

const OPPOSITE: Record<Exclude<Handle, "rotate">, Exclude<Handle, "rotate">> = { nw: "se", ne: "sw", se: "nw", sw: "ne" };

export interface ScaleResult {
  /** New size relative to the starting size (> 0). */
  factor: number;
  /** New centre. */
  cx: number;
  cy: number;
}

/**
 * Dragging a corner scales the layer uniformly. The opposite corner stays
 * put, or the centre does with fromCenter (Alt). start is the box when the
 * drag began, p the pointer.
 */
export function scaleFromHandle(start: Box, handle: Exclude<Handle, "rotate">, p: Point, fromCenter: boolean, minFactor = 0.02): ScaleResult {
  const corners = boxCorners(start);
  const idx = { nw: 0, ne: 1, se: 2, sw: 3 } as const;
  const grabbed = corners[idx[handle]];
  const anchor = fromCenter ? { x: start.cx, y: start.cy } : corners[idx[OPPOSITE[handle]]];
  const base = { x: grabbed.x - anchor.x, y: grabbed.y - anchor.y };
  const baseLen2 = base.x * base.x + base.y * base.y;
  if (baseLen2 === 0) return { factor: 1, cx: start.cx, cy: start.cy };
  // Project the pointer onto the anchor→corner diagonal.
  const dot = (p.x - anchor.x) * base.x + (p.y - anchor.y) * base.y;
  const factor = Math.max(minFactor, dot / baseLen2);
  if (fromCenter) return { factor, cx: start.cx, cy: start.cy };
  // Keep the anchor fixed: the centre moves along anchor→centre by the factor.
  return { factor, cx: anchor.x + (start.cx - anchor.x) * factor, cy: anchor.y + (start.cy - anchor.y) * factor };
}

/** Rotation in degrees (clockwise, 0 = rotate handle straight above) for a pointer at p. */
export function rotationFromPointer(b: Pick<Box, "cx" | "cy">, p: Point, snapStep = 0): number {
  let deg = (Math.atan2(p.y - b.cy, p.x - b.cx) * 180) / Math.PI + 90;
  deg = ((((deg + 180) % 360) + 360) % 360) - 180;
  if (snapStep > 0) deg = Math.round(deg / snapStep) * snapStep;
  return deg;
}

// --- snapping -------------------------------------------------------------------

export interface Guide {
  axis: "x" | "y";
  /** Position on the axis (x for a vertical line, y for a horizontal one). */
  pos: number;
  /** Extent along the other axis. */
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

/** Lines of a box: its left/centre/right (x) or top/centre/bottom (y). */
function lines(b: Box, axis: "x" | "y"): number[] {
  const r = boxBounds(b);
  return axis === "x" ? [r.left, (r.left + r.right) / 2, r.right] : [r.top, (r.top + r.bottom) / 2, r.bottom];
}

interface Target {
  pos: number;
  from: number;
  to: number;
}

function targets(doc: Pick<Composition, "width" | "height">, others: Box[], axis: "x" | "y"): Target[] {
  const size = axis === "x" ? doc.width : doc.height;
  const cross = axis === "x" ? doc.height : doc.width;
  const out: Target[] = [0, size / 2, size].map((pos) => ({ pos, from: 0, to: cross }));
  for (const o of others) {
    const r = boxBounds(o);
    const from = axis === "x" ? r.top : r.left;
    const to = axis === "x" ? r.bottom : r.right;
    for (const pos of lines(o, axis)) out.push({ pos, from, to });
  }
  return out;
}

function snapAxis(doc: Pick<Composition, "width" | "height">, moving: Box, others: Box[], axis: "x" | "y", threshold: number): { delta: number; guides: Guide[] } {
  const mine = lines(moving, axis);
  const mb = boxBounds(moving);
  const mFrom = axis === "x" ? mb.top : mb.left;
  const mTo = axis === "x" ? mb.bottom : mb.right;
  let best = Infinity;
  for (const t of targets(doc, others, axis)) {
    for (const m of mine) {
      const d = t.pos - m;
      if (Math.abs(d) <= threshold && Math.abs(d) < Math.abs(best)) best = d;
    }
  }
  if (!Number.isFinite(best)) return { delta: 0, guides: [] };
  const guides: Guide[] = [];
  const seen = new Set<number>();
  for (const t of targets(doc, others, axis)) {
    for (const m of mine) {
      if (Math.abs(t.pos - (m + best)) < 0.01 && !seen.has(Math.round(t.pos * 100))) {
        seen.add(Math.round(t.pos * 100));
        guides.push({ axis, pos: t.pos, from: Math.min(t.from, mFrom), to: Math.max(t.to, mTo) });
      }
    }
  }
  return { delta: best, guides };
}

/**
 * Snaps a box being moved: its edges and centre to the canvas edges and
 * centre and to other layers' edges and centres, within threshold canvas px.
 * Returns the correction to add to the move plus the guide lines to draw.
 */
export function snapMove(doc: Pick<Composition, "width" | "height">, moving: Box, others: Box[], threshold: number): SnapResult {
  const x = snapAxis(doc, moving, others, "x", threshold);
  const y = snapAxis(doc, moving, others, "y", threshold);
  return { dx: x.delta, dy: y.delta, guides: [...x.guides, ...y.guides] };
}
