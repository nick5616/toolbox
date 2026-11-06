// Liquify: dabs add to a displacement field (push, twirl, pinch, expand,
// crystals); apply() resamples the snapshot through it. Deterministic: the
// crystals mode draws from a seeded stream, one draw pair per pixel position.

import { createRng, mixSeed } from "../brushes/rng";
import { newBuf, premultiplied, straightImage } from "../engine/pixels";
import { sampleBilinear } from "../engine/sample";
import type { Img } from "./color";

export type LiquifyMode = "push" | "twirl" | "pinch" | "expand" | "crystals";

export class LiquifyField {
  /** Where each output pixel reads from, relative to itself. */
  readonly dx: Float32Array;
  readonly dy: Float32Array;
  private n = 0;

  constructor(
    readonly w: number,
    readonly h: number,
    private readonly seed = 1,
  ) {
    this.dx = new Float32Array(w * h);
    this.dy = new Float32Array(w * h);
  }

  /** One dab at (cx, cy). strength 0..1; (mx, my) is the drag since the last dab (push). */
  dab(mode: LiquifyMode, cx: number, cy: number, radius: number, strength: number, mx = 0, my = 0): void {
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(this.w - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(this.h - 1, Math.ceil(cy + radius));
    const rng = createRng(mixSeed(this.seed, this.n++));
    const jx = rng() - 0.5;
    const jy = rng() - 0.5;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5 - cx;
        const py = y + 0.5 - cy;
        const d = Math.hypot(px, py);
        if (d >= radius) continue;
        const f = (1 - d / radius) ** 2 * strength;
        const i = y * this.w + x;
        switch (mode) {
          case "push":
            this.dx[i] = (this.dx[i] as number) - mx * f;
            this.dy[i] = (this.dy[i] as number) - my * f;
            break;
          case "twirl": {
            const a = f * 0.35;
            const cs = Math.cos(-a);
            const sn = Math.sin(-a);
            this.dx[i] = (this.dx[i] as number) + (px * cs - py * sn - px);
            this.dy[i] = (this.dy[i] as number) + (px * sn + py * cs - py);
            break;
          }
          case "pinch":
            this.dx[i] = (this.dx[i] as number) + px * f * 0.4;
            this.dy[i] = (this.dy[i] as number) + py * f * 0.4;
            break;
          case "expand":
            this.dx[i] = (this.dx[i] as number) - px * f * 0.4;
            this.dy[i] = (this.dy[i] as number) - py * f * 0.4;
            break;
          case "crystals": {
            // A jagged, faceted shove: direction flips by facet.
            const facet = Math.floor((Math.atan2(py, px) + Math.PI) / (Math.PI / 3));
            const ang = facet * 1.7 + jx * 6 + jy;
            this.dx[i] = (this.dx[i] as number) + Math.cos(ang) * radius * f * 0.25;
            this.dy[i] = (this.dy[i] as number) + Math.sin(ang) * radius * f * 0.25;
            break;
          }
        }
      }
    }
  }

  /** The snapshot warped by the field. */
  apply(img: Img): ImageData {
    const src = premultiplied(img);
    const out = newBuf(img.width, img.height);
    const px = [0, 0, 0, 0];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        const ddx = this.dx[i] as number;
        const ddy = this.dy[i] as number;
        const o = i * 4;
        if (ddx === 0 && ddy === 0) {
          out.data.set(src.data.subarray(o, o + 4), o);
          continue;
        }
        sampleBilinear(src, x + 0.5 + ddx, y + 0.5 + ddy, px);
        out.data[o] = px[0] as number;
        out.data[o + 1] = px[1] as number;
        out.data[o + 2] = px[2] as number;
        out.data[o + 3] = px[3] as number;
      }
    }
    return straightImage(out);
  }
}
