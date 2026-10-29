// Pure mask logic for the Object Eraser: no DOM, so it is unit-testable in jsdom.

/** Longest side of the on-screen mask canvas (SPEC §9.3). */
export const MASK_CAP = 4096;
/** Longest side the backend accepts for an exported mask (SPEC §9.1). */
export const EXPORT_CAP = 8192;
export const UNDO_STEPS = 50;
export const BRUSH_MIN = 4;
export const BRUSH_MAX = 300;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 32;

export interface Size {
  w: number;
  h: number;
}

/** Scales (w, h) down so the longest side is at most `cap`; never up. */
export function capSize(w: number, h: number, cap: number): Size {
  const long = Math.max(w, h);
  if (long <= cap || long <= 0) return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
  const k = cap / long;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** Size of the painting canvas for an image (capped at 4096). */
export function maskSize(natW: number, natH: number): Size {
  return capSize(natW, natH, MASK_CAP);
}

/** Size of the exported mask PNG: the image's natural size (capped at 8192). */
export function exportSize(natW: number, natH: number): Size {
  return capSize(natW, natH, EXPORT_CAP);
}

// ---- strokes and history ----

export interface Point {
  x: number;
  y: number;
}

export type Stroke =
  | { kind: "brush" | "unpaint"; size: number; points: Point[] }
  | { kind: "clear" };

/** Undo/redo over strokes (50 undo steps). Replaying `applied` rebuilds the mask. */
export class MaskHistory {
  private applied: Stroke[] = [];
  private redone: Stroke[] = [];
  private depth = 0;

  /** Strokes to replay, oldest first (starts at the last clear). */
  strokes(): Stroke[] {
    let start = 0;
    for (let i = this.applied.length - 1; i >= 0; i--) {
      if (this.applied[i]?.kind === "clear") {
        start = i + 1;
        break;
      }
    }
    return this.applied.slice(start);
  }

  push(s: Stroke): void {
    this.applied.push(s);
    this.redone = [];
    this.depth = Math.min(UNDO_STEPS, this.depth + 1);
  }

  get canUndo(): boolean {
    return this.depth > 0;
  }

  get canRedo(): boolean {
    return this.redone.length > 0;
  }

  /** Returns true when something was undone. */
  undo(): boolean {
    if (this.depth <= 0) return false;
    const s = this.applied.pop();
    if (!s) return false;
    this.redone.push(s);
    this.depth--;
    return true;
  }

  redo(): boolean {
    const s = this.redone.pop();
    if (!s) return false;
    this.applied.push(s);
    this.depth = Math.min(UNDO_STEPS, this.depth + 1);
    return true;
  }

  /** True when a brush stroke exists after the last clear (a heuristic: unpaint may have emptied it). */
  get hasPaint(): boolean {
    return this.strokes().some((s) => s.kind === "brush");
  }

  reset(): void {
    this.applied = [];
    this.redone = [];
    this.depth = 0;
  }
}

// ---- geometry ----

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Client (screen) coordinates to mask-canvas pixels, given the canvas's on-screen rect. */
export function clientToMask(clientX: number, clientY: number, rect: Rect, mask: Size): Point {
  return {
    x: ((clientX - rect.left) / rect.width) * mask.w,
    y: ((clientY - rect.top) / rect.height) * mask.h,
  };
}

/** A brush diameter in screen px to mask px for the current on-screen width of the canvas. */
export function brushToMask(screenSize: number, rect: Rect, mask: Size): number {
  if (rect.width <= 0) return screenSize;
  return Math.max(1, (screenSize * mask.w) / rect.width);
}

export function clampBrush(n: number): number {
  return Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, Math.round(n)));
}

/** Scale that fits an image inside a container (never above 1 only when `allowUpscale` is false). */
export function fitScale(container: Size, image: Size): number {
  if (image.w <= 0 || image.h <= 0 || container.w <= 0 || container.h <= 0) return 1;
  return Math.min(container.w / image.w, container.h / image.h);
}

export interface View {
  /** Multiplier of the fit scale. */
  zoom: number;
  /** Offset of the image centre from the container centre, in screen px. */
  panX: number;
  panY: number;
}

export const FIT_VIEW: View = { zoom: 1, panX: 0, panY: 0 };

export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** Zooms by `factor` keeping the point under (px, py) fixed; px/py are relative to the container centre. */
export function zoomAround(v: View, factor: number, px: number, py: number): View {
  const zoom = clampZoom(v.zoom * factor);
  const r = zoom / v.zoom;
  return { zoom, panX: px - (px - v.panX) * r, panY: py - (py - v.panY) * r };
}

/** The zoom multiplier that shows the image at 100% (one image pixel per screen px). */
export function actualSizeZoom(container: Size, image: Size): number {
  const fit = fitScale(container, image);
  return fit > 0 ? 1 / fit : 1;
}

// ---- pixels ----

/** True when no pixel has any alpha (RGBA data, alpha every 4th byte). */
export function maskIsEmpty(data: ArrayLike<number>): boolean {
  for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 0) return false;
  return true;
}

/** Minimal 2D context surface used for drawing strokes (satisfied by CanvasRenderingContext2D). */
export interface StrokeCtx {
  globalCompositeOperation: GlobalCompositeOperation;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  stroke(): void;
  fill(): void;
  clearRect(x: number, y: number, w: number, h: number): void;
}

/** Draws points[from..] of a brush/unpaint stroke (continuing from points[from-1] when from > 0). */
export function drawStroke(ctx: StrokeCtx, s: Stroke, color: string, from = 0): void {
  if (s.kind === "clear") return;
  ctx.globalCompositeOperation = s.kind === "unpaint" ? "destination-out" : "source-over";
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = s.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const pts = s.points;
  if (pts.length === 1 && from === 0) {
    const p = pts[0];
    if (!p) return;
    ctx.beginPath();
    ctx.arc(p.x, p.y, s.size / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const start = Math.max(0, from - 1);
  const first = pts[start];
  if (!first) return;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (let i = start + 1; i < pts.length; i++) {
    const p = pts[i];
    if (p) ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

/** Redraws a whole history onto a cleared context. */
export function replay(ctx: StrokeCtx, h: MaskHistory, size: Size, color: string): void {
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, size.w, size.h);
  for (const s of h.strokes()) drawStroke(ctx, s, color);
}

/** Normalises a PNG data URL / base64 for display purposes (the backend accepts both forms). */
export function isPngDataURL(s: string): boolean {
  return s.startsWith("data:image/png;base64,") && s.length > "data:image/png;base64,".length;
}
