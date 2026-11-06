// Smudge with any brush: a CPU pass over the layer's pixels. The brush carries
// a pickup buffer (relative to the dab) that it deposits and refreshes as it
// moves, so colour drags along the stroke.

import { dabAlpha, loadDab, newGeo, type DabGeo } from "../engine/dabmath";
import { DAB_STRIDE, D, type DabStyle } from "../engine/gl";
import { rectsIntersect } from "../engine/pixels";
import type { TilePixels } from "../engine/region";
import type { Rect } from "../engine/types";

export class Smudger {
  private pickup: Float32Array | null = null;
  private n = 0;
  private readonly g: DabGeo = newGeo();
  bounds: Rect | null = null;

  constructor(
    private readonly px: TilePixels,
    private readonly style: DabStyle,
    /** 0..1: how much of the carried colour a dab deposits. */
    private readonly strength: number,
    private readonly canvas: Rect,
    private readonly alphaLock: boolean,
    private readonly selection: Uint8Array | null,
  ) {}

  /** Smudge along dabs [start, end) of a dab list. */
  run(f: Float32Array, start: number, end: number): void {
    for (let i = start; i < end; i++) this.dab(f, i * DAB_STRIDE);
  }

  private dab(f: Float32Array, o: number): void {
    const g = this.g;
    if (!loadDab(g, f, o)) return;
    const n = Math.ceil(g.reach * 2);
    const rx = Math.floor(g.x - n / 2);
    const ry = Math.floor(g.y - n / 2);
    const region: Rect = { x: rx, y: ry, w: n, h: n };
    if (!rectsIntersect(region, this.canvas)) return;
    const c = this.px.read(region).data; // premult bytes
    if (!this.pickup || this.n !== n) {
      // First dab (or a size change): pick up what is under the brush; deposit nothing yet.
      const p = new Float32Array(n * n * 4);
      for (let i = 0; i < p.length; i++) p[i] = c[i] as number;
      this.pickup = p;
      this.n = n;
      return;
    }
    const p = this.pickup;
    const out = new Uint8ClampedArray(c.length);
    const pull = 1 - this.strength;
    const cw = this.canvas.w;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = (j * n + i) * 4;
        const wx = rx + i;
        const wy = ry + j;
        let m = 0;
        if (wx >= 0 && wy >= 0 && wx < cw && wy < this.canvas.h) m = dabAlpha(this.style, g, wx + 0.5, wy + 0.5);
        if (m > 0 && this.selection) m *= (this.selection[wy * cw + wx] as number) / 255;
        const d = m * this.strength;
        for (let ch = 0; ch < 4; ch++) {
          const cv = c[k + ch] as number;
          const pv = p[k + ch] as number;
          out[k + ch] = Math.round(cv + (pv - cv) * d);
          // Refresh what the brush carries toward the canvas it just crossed.
          p[k + ch] = pv + (cv - pv) * m * pull;
        }
        if (this.alphaLock) {
          const oa = c[k + 3] as number;
          const na = out[k + 3] as number;
          if (na > 0) {
            const s = oa / na;
            for (let ch = 0; ch < 3; ch++) out[k + ch] = Math.min(oa, Math.round((out[k + ch] as number) * s));
          }
          out[k + 3] = oa;
        }
      }
    }
    this.px.write(region, { w: n, h: n, data: out });
    this.bounds = this.bounds ? unite(this.bounds, region) : region;
  }
}

function unite(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export { D };
