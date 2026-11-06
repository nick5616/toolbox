// CPU reference GLBackend: the same maths as shaders.ts, per pixel in JS. Used
// by vitest (no WebGL in jsdom) and as the spec for the shaders.

import { blendInto } from "./blend";
import { dabAlpha, loadDab, newGeo, type MaskData } from "./dabmath";
import { D, DAB_STRIDE, type BlendParams, type DabBatch, type DabStyle, type GLBackend, type MaskTex, type MergeParams, type PresentArgs, type Surface } from "./gl";
import { clamp } from "./pixels";

export interface CpuSurface extends Surface {
  data: Uint8ClampedArray;
}

export function createCpuBackend(tile = 512): GLBackend & { surfaceData(s: Surface): Uint8ClampedArray } {
  let comp = new Uint8ClampedArray(0);
  let compW = 0;
  const size = tile;
  const bytes = size * size * 4;

  const sd = (s: Surface) => (s as CpuSurface).data;

  const be = {
    name: "cpu" as const,
    gl: null,
    tile,
    surfaceData: sd,
    createSurface(): Surface {
      return { w: size, h: size, data: new Uint8ClampedArray(bytes) } as CpuSurface;
    },
    destroySurface(): void {},
    clear(s: Surface) {
      sd(s).fill(0);
    },
    fill(s: Surface, r: number, g: number, b: number, a: number) {
      const d = sd(s);
      for (let i = 0; i < d.length; i += 4) {
        d[i] = r;
        d[i + 1] = g;
        d[i + 2] = b;
        d[i + 3] = a;
      }
    },
    copy(dst: Surface, src: Surface) {
      sd(dst).set(sd(src));
    },
    upload(s: Surface, data: Uint8ClampedArray, x: number, y: number, w: number, h: number) {
      const d = sd(s);
      for (let row = 0; row < h; row++) d.set(data.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * size + x) * 4);
    },
    download(s: Surface, x: number, y: number, w: number, h: number): Uint8ClampedArray {
      const d = sd(s);
      const out = new Uint8ClampedArray(w * h * 4);
      for (let row = 0; row < h; row++) out.set(d.subarray(((y + row) * size + x) * 4, ((y + row) * size + x + w) * 4), row * w * 4);
      return out;
    },
    createMask(data: Uint8Array | Uint8ClampedArray, w: number, h: number): MaskTex {
      const f = new Float32Array(w * h);
      for (let i = 0; i < f.length; i++) f[i] = (data[i] as number) / 255;
      return { w, h, data: f } as MaskData;
    },
    destroyMask(): void {},

    drawDabs(dst: Surface, ox: number, oy: number, batch: DabBatch, style: DabStyle, source: Surface | null, clip: { x: number; y: number; w: number; h: number }) {
      const d = sd(dst);
      const src = source ? sd(source) : null;
      const cx0 = Math.max(0, clip.x - ox);
      const cy0 = Math.max(0, clip.y - oy);
      const cx1 = Math.min(size, clip.x + clip.w - ox);
      const cy1 = Math.min(size, clip.y + clip.h - oy);
      const f = batch.data;
      const g = newGeo();
      for (let n = batch.start; n < batch.end; n++) {
        const o = n * DAB_STRIDE;
        if (!loadDab(g, f, o)) continue;
        const x0 = Math.max(cx0, Math.floor(g.x - ox - g.reach));
        const x1 = Math.min(cx1, Math.ceil(g.x - ox + g.reach));
        const y0 = Math.max(cy0, Math.floor(g.y - oy - g.reach));
        const y1 = Math.min(cy1, Math.ceil(g.y - oy + g.reach));
        if (x1 <= x0 || y1 <= y0) continue;
        const cr = f[o + D.R] as number;
        const cg = f[o + D.G] as number;
        const cb = f[o + D.B] as number;
        const wet = f[o + D.WET] as number;
        const pullX = f[o + D.PULLX] as number;
        const pullY = f[o + D.PULLY] as number;
        for (let py = y0; py < y1; py++) {
          for (let px = x0; px < x1; px++) {
            const a = dabAlpha(style, g, px + ox + 0.5, py + oy + 0.5);
            if (a <= 0) continue;
            let r = cr;
            let gg = cg;
            let b = cb;
            if (style.coverageOnly) {
              r = gg = b = 0;
            } else if (src && wet > 0) {
              const sx = clamp(Math.floor(px + 0.5 + pullX), 0, size - 1);
              const sy = clamp(Math.floor(py + 0.5 + pullY), 0, size - 1);
              const si = (sy * size + sx) * 4;
              const sa = (src[si + 3] as number) / 255;
              if (sa > 0) {
                const m = wet * sa;
                r = r * (1 - m) + ((src[si] as number) / 255 / sa) * m;
                gg = gg * (1 - m) + ((src[si + 1] as number) / 255 / sa) * m;
                b = b * (1 - m) + ((src[si + 2] as number) / 255 / sa) * m;
              }
            }
            const i = (py * size + px) * 4;
            if (style.rendering === 1) {
              d[i] = Math.max(d[i] as number, Math.round(r * a * 255));
              d[i + 1] = Math.max(d[i + 1] as number, Math.round(gg * a * 255));
              d[i + 2] = Math.max(d[i + 2] as number, Math.round(b * a * 255));
              d[i + 3] = Math.max(d[i + 3] as number, Math.round(a * 255));
            } else {
              const k = 1 - a;
              d[i] = Math.round(r * a * 255 + (d[i] as number) * k);
              d[i + 1] = Math.round(gg * a * 255 + (d[i + 1] as number) * k);
              d[i + 2] = Math.round(b * a * 255 + (d[i + 2] as number) * k);
              d[i + 3] = Math.round(a * 255 + (d[i + 3] as number) * k);
            }
          }
        }
      }
    },

    mergeScratch(layer: Surface, scratch: Surface, p: MergeParams) {
      const d = sd(layer);
      const s = sd(scratch);
      const sel = p.selection ? sd(p.selection) : null;
      const rev = p.source ? sd(p.source) : null;
      const light = p.impasto > 0;
      const lx = -0.5;
      const ly = -0.5;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          let a = (s[i + 3] as number) / 255;
          if (a <= 0) continue;
          let selA = 1;
          if (sel) {
            selA = (sel[i + 3] as number) / 255;
            if (selA <= 0) continue;
          }
          let r = (s[i] as number) / 255 / a;
          let g = (s[i + 1] as number) / 255 / a;
          let b = (s[i + 2] as number) / 255 / a;
          if (p.wetEdges > 0) a = clamp(a * (1 - 0.4 * p.wetEdges) + p.wetEdges * 1.6 * a * (1 - a), 0, 1);
          if (light) {
            const xl = x > 0 ? x - 1 : x;
            const xr = x < size - 1 ? x + 1 : x;
            const yu = y > 0 ? y - 1 : y;
            const yd = y < size - 1 ? y + 1 : y;
            const gx = (((s[(y * size + xr) * 4 + 3] as number) - (s[(y * size + xl) * 4 + 3] as number)) / 255) / Math.max(1, xr - xl);
            const gy = (((s[(yd * size + x) * 4 + 3] as number) - (s[(yu * size + x) * 4 + 3] as number)) / 255) / Math.max(1, yd - yu);
            const shade = (gx * lx + gy * ly) * 6 * p.impasto;
            r = clamp(r + shade, 0, 1);
            g = clamp(g + shade, 0, 1);
            b = clamp(b + shade, 0, 1);
          }
          const eff = a * p.opacity * selA;
          if (eff <= 0) continue;
          if (p.op === "erase") {
            const k = 1 - eff;
            d[i] = Math.round((d[i] as number) * k);
            d[i + 1] = Math.round((d[i + 1] as number) * k);
            d[i + 2] = Math.round((d[i + 2] as number) * k);
            d[i + 3] = Math.round((d[i + 3] as number) * k);
          } else if (p.op === "revert") {
            for (let c = 0; c < 4; c++) {
              const t = rev ? (rev[i + c] as number) : 0;
              d[i + c] = Math.round((d[i + c] as number) * (1 - eff) + t * eff);
            }
          } else {
            blendInto(d, i, r * eff, g * eff, b * eff, eff, p.mode, p.op === "atop");
          }
        }
      }
    },

    blend(dst: Surface, src: Surface, p: BlendParams) {
      const d = sd(dst);
      const s = sd(src);
      const atop = p.atop === true;
      for (let i = 0; i < d.length; i += 4) {
        const sa = (s[i + 3] as number) / 255;
        if (sa <= 0) continue;
        const o = p.opacity;
        blendInto(d, i, ((s[i] as number) / 255) * o, ((s[i + 1] as number) / 255) * o, ((s[i + 2] as number) / 255) * o, sa * o, p.mode, atop);
      }
    },

    uploadAlpha(s: Surface, mask: Uint8Array, x: number, y: number, w: number, h: number) {
      const d = sd(s);
      for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) d[((y + row) * size + x + col) * 4 + 3] = mask[row * w + col] as number;
    },

    resizeComposite(w: number, h: number) {
      compW = w;
      comp = new Uint8ClampedArray(w * h * 4);
    },
    storeComposite(tileSurf: Surface, x: number, y: number, w: number, h: number) {
      const t = sd(tileSurf);
      for (let row = 0; row < h; row++) comp.set(t.subarray(row * size * 4, (row * size + w) * 4), ((y + row) * compW + x) * 4);
    },
    readComposite(): Uint8ClampedArray {
      return comp;
    },
    present(_a: PresentArgs): void {},
    dispose(): void {},
  };
  return be;
}
