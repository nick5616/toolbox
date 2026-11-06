// CPU twins of some viz/post shaders. They follow the shader source line by
// line (uv = (x + 0.5) / size, premultiplied bilinear sampling, clamped edges)
// so the GL and CPU paths agree within rounding. Params are the post's own.

import type { PostType } from "@/viz/types";
import { hexToLinear } from "@/viz/palette";
import { pixelBlock } from "@/viz/post/fx2math";
import { clamp, luma, makeImage, sampleBilinear } from "./common";

export type PostParams = Record<string, number | string | boolean>;
export type CpuPost = (src: ImageData, p: PostParams) => ImageData;

const n = (p: PostParams, id: string): number => p[id] as number;
const glMod = (x: number, y: number): number => x - y * Math.floor(x / y);

/** Runs `uvMap` for every pixel: it returns where to read (uv), or null to copy. */
function remap(src: ImageData, map: (u: number, v: number, w: number, h: number) => [number, number] | null): ImageData {
  const w = src.width;
  const h = src.height;
  const out = makeImage(w, h);
  const tmp = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const m = map((x + 0.5) / w, (y + 0.5) / h, w, h);
      const k = (y * w + x) * 4;
      if (!m) {
        out.data.set(src.data.subarray(k, k + 4), k);
        continue;
      }
      sampleBilinear(src, m[0] * w, m[1] * h, tmp);
      out.data[k] = tmp[0] as number;
      out.data[k + 1] = tmp[1] as number;
      out.data[k + 2] = tmp[2] as number;
      out.data[k + 3] = tmp[3] as number;
    }
  }
  return out;
}

function perPixel(src: ImageData, f: (r: number, g: number, b: number, a: number) => [number, number, number]): ImageData {
  const out = makeImage(src.width, src.height, new Uint8ClampedArray(src.data));
  for (let i = 0; i < src.width * src.height; i++) {
    const a = (src.data[i * 4 + 3] as number) / 255;
    if (a <= 0) continue;
    const c = f((src.data[i * 4] as number) / 255, (src.data[i * 4 + 1] as number) / 255, (src.data[i * 4 + 2] as number) / 255, a);
    out.data[i * 4] = c[0] * 255;
    out.data[i * 4 + 1] = c[1] * 255;
    out.data[i * 4 + 2] = c[2] * 255;
  }
  return out;
}

export const CPU_POSTS: Partial<Record<PostType, CpuPost>> = {
  posterize(src, p) {
    const amt = n(p, "amount");
    const levels = Math.max(2, Math.round(n(p, "levels")));
    if (amt <= 0) return src;
    const nn = levels - 1;
    return perPixel(src, (r, g, b) => {
      const q = (v: number) => Math.floor(clamp(v, 0, 1) * nn + 0.5) / nn;
      return [r + (q(r) - r) * amt, g + (q(g) - g) * amt, b + (q(b) - b) * amt];
    });
  },
  duotone(src, p) {
    const amt = n(p, "amount");
    if (amt <= 0) return src;
    const sh = hexToLinear(p.shadows as string);
    const hi = hexToLinear(p.highlights as string);
    return perPixel(src, (r, g, b) => {
      const l = clamp(luma(r * 255, g * 255, b * 255), 0, 1);
      const t = (a: number, c: number) => a + (c - a) * l;
      return [r + (t(sh[0], hi[0]) - r) * amt, g + (t(sh[1], hi[1]) - g) * amt, b + (t(sh[2], hi[2]) - b) * amt];
    });
  },
  pixelate(src, p) {
    const block = pixelBlock(n(p, "amount"), Math.min(src.width, src.height));
    if (block <= 1) return src;
    return remap(src, (u, v, w, h) => {
      const cx = Math.min((Math.floor((u * w) / block) + 0.5) * block, w - 0.5);
      const cy = Math.min((Math.floor((v * h) / block) + 0.5) * block, h - 0.5);
      return [cx / w, cy / h];
    });
  },
  twirl(src, p) {
    const amt = n(p, "amount");
    const rad = n(p, "radius");
    const cx = n(p, "cx");
    const cy = n(p, "cy");
    if (amt === 0) return src;
    return remap(src, (u, v, w, h) => {
      const s = Math.min(w, h);
      const px = ((u - cx) * w) / s;
      const py = ((v - cy) * h) / s;
      const r = Math.hypot(px, py);
      if (rad <= 0 || r >= rad) return null;
      const k = 1 - r / rad;
      const a = amt * 6.2831853 * k * k;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      return [cx + ((c * px - sn * py) * s) / w, cy + ((sn * px + c * py) * s) / h];
    });
  },
  bulge(src, p) {
    const amt = n(p, "amount");
    const rad = n(p, "radius");
    const cx = n(p, "cx");
    const cy = n(p, "cy");
    if (amt === 0 || rad <= 0) return src;
    return remap(src, (u, v, w, h) => {
      const s = Math.min(w, h);
      const px = ((u - cx) * w) / s;
      const py = ((v - cy) * h) / s;
      const rn = Math.hypot(px, py) / rad;
      if (rn >= 1) return null;
      const f = 1 - 0.8 * amt * (1 - rn * rn);
      return [cx + (px * f * s) / w, cy + (py * f * s) / h];
    });
  },
  wave(src, p) {
    const amt = n(p, "amount");
    const freq = n(p, "freq");
    if (amt <= 0) return src;
    const vert = p.dir === "vertical";
    return remap(src, (u, v) => (vert ? [u + amt * 0.05 * Math.sin(6.2831853 * (freq * v)), v] : [u, v + amt * 0.05 * Math.sin(6.2831853 * (freq * u))]));
  },
  kaleido(src, p) {
    const amt = n(p, "amount");
    if (amt <= 0) return src;
    const seg = 6.2831853 / Math.max(2, Math.round(n(p, "segments")));
    const rot = (n(p, "rotation") * Math.PI) / 180;
    const zoom = n(p, "zoom");
    const out = makeImage(src.width, src.height);
    const tmp = [0, 0, 0, 0];
    const w = src.width;
    const h = src.height;
    const s = Math.min(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = (x + 0.5) / w;
        const v = (y + 0.5) / h;
        const px = ((u - 0.5) * w) / s;
        const py = ((v - 0.5) * h) / s;
        const r = Math.hypot(px, py);
        let a = glMod(Math.atan2(py, px) - rot, seg * 2);
        a = a > seg ? seg * 2 - a : a;
        const qx = (Math.cos(a) * r) / zoom;
        const qy = (Math.sin(a) * r) / zoom;
        let su = (qx * s) / w + 0.5;
        let sv = (qy * s) / h + 0.5;
        su = 1 - Math.abs(1 - glMod(su, 2));
        sv = 1 - Math.abs(1 - glMod(sv, 2));
        mixSamples(src, out, x, y, u, v, su, sv, amt, tmp);
      }
    }
    return out;
  },
  mirror(src, p) {
    const amt = n(p, "mix");
    const seg = 6.2831853 / Math.max(2, Math.round(n(p, "segments")));
    const zoom = n(p, "zoom");
    const out = makeImage(src.width, src.height);
    const tmp = [0, 0, 0, 0];
    const w = src.width;
    const h = src.height;
    const s = Math.min(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = (x + 0.5) / w;
        const v = (y + 0.5) / h;
        const px = ((u - 0.5) * w) / s;
        const py = ((v - 0.5) * h) / s;
        const r = Math.hypot(px, py);
        let a = glMod(Math.atan2(py, px), seg * 2);
        a = a > seg ? seg * 2 - a : a;
        const qx = (Math.cos(a) * r) / zoom;
        const qy = (Math.sin(a) * r) / zoom;
        let su = (qx * s) / w + 0.5;
        let sv = (qy * s) / h + 0.5;
        su = 1 - Math.abs(1 - Math.abs(su));
        sv = 1 - Math.abs(1 - Math.abs(sv));
        mixSamples(src, out, x, y, u, v, su, sv, amt, tmp);
      }
    }
    return out;
  },
};

/** o = mix(texture(src, uv), texture(src, suv), amt), in premultiplied space, written as straight. */
function mixSamples(src: ImageData, out: ImageData, x: number, y: number, u: number, v: number, su: number, sv: number, amt: number, tmp: number[]): void {
  const w = src.width;
  const h = src.height;
  sampleBilinear(src, u * w, v * h, tmp);
  const a0 = (tmp[3] as number) / 255;
  const p0 = [(tmp[0] as number) * a0, (tmp[1] as number) * a0, (tmp[2] as number) * a0];
  sampleBilinear(src, su * w, sv * h, tmp);
  const a1 = (tmp[3] as number) / 255;
  const p1 = [(tmp[0] as number) * a1, (tmp[1] as number) * a1, (tmp[2] as number) * a1];
  const a = a0 + (a1 - a0) * amt;
  const k = (y * w + x) * 4;
  for (let c = 0; c < 3; c++) out.data[k + c] = a > 1e-6 ? ((p0[c] as number) + ((p1[c] as number) - (p0[c] as number)) * amt) / a : 0;
  out.data[k + 3] = a * 255;
}
