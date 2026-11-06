// View transform: zoom, pan, rotation and flip. Positions are CSS px in the
// canvas element; pan is the offset of the canvas centre from the viewport
// centre, so rotating and zooming happen about the middle of the canvas.

import type { Affine } from "./sample";
import type { Point, ViewAPI, ViewState } from "./types";

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;

export class ViewImpl implements ViewAPI {
  state: ViewState = { zoom: 1, panX: 0, panY: 0, rotation: 0, flipped: false };
  vw = 800;
  vh = 600;
  constructor(
    private readonly doc: () => { w: number; h: number },
    private readonly changed: () => void,
  ) {}

  get(): ViewState {
    return { ...this.state };
  }

  set(v: Partial<ViewState>): void {
    const s = { ...this.state, ...v };
    s.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, s.zoom));
    this.state = s;
    this.changed();
  }

  setViewport(w: number, h: number): void {
    this.vw = Math.max(1, w);
    this.vh = Math.max(1, h);
    this.changed();
  }

  fit(): void {
    const { w, h } = this.doc();
    const r = (this.state.rotation * Math.PI) / 180;
    const bw = Math.abs(w * Math.cos(r)) + Math.abs(h * Math.sin(r));
    const bh = Math.abs(w * Math.sin(r)) + Math.abs(h * Math.cos(r));
    this.set({ zoom: Math.min((this.vw * 0.92) / bw, (this.vh * 0.92) / bh), panX: 0, panY: 0 });
  }

  actual(): void {
    this.set({ zoom: 1, panX: 0, panY: 0 });
  }

  /** Canvas px → CSS px. */
  matrix(): Affine {
    const { w, h } = this.doc();
    const { zoom, panX, panY, rotation, flipped } = this.state;
    const r = (rotation * Math.PI) / 180;
    const cs = Math.cos(r);
    const sn = Math.sin(r);
    const fx = flipped ? -1 : 1;
    const a = zoom * cs * fx;
    const b = zoom * sn * fx;
    const c = -zoom * sn;
    const d = zoom * cs;
    const cx = w / 2;
    const cy = h / 2;
    return [a, b, c, d, this.vw / 2 + panX - (a * cx + c * cy), this.vh / 2 + panY - (b * cx + d * cy)];
  }

  canvasToScreen(p: Point): Point {
    const m = this.matrix();
    return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
  }

  screenToCanvas(p: Point): Point {
    const m = this.matrix();
    const det = m[0] * m[3] - m[1] * m[2];
    const x = p.x - m[4];
    const y = p.y - m[5];
    return { x: (m[3] * x - m[2] * y) / det, y: (-m[1] * x + m[0] * y) / det };
  }
}
