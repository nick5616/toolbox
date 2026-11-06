// Gaussian blur, motion blur, sharpen and noise. Blurs work on premultiplied
// floats so transparent edges don't bleed dark.

import { createRng } from "../brushes/rng";
import { makeImageData } from "../engine/pixels";
import type { Img } from "./color";

function toPremul(img: Img): Float32Array {
  const out = new Float32Array(img.data.length);
  for (let i = 0; i < out.length; i += 4) {
    const a = (img.data[i + 3] as number) / 255;
    out[i] = (img.data[i] as number) * a;
    out[i + 1] = (img.data[i + 1] as number) * a;
    out[i + 2] = (img.data[i + 2] as number) * a;
    out[i + 3] = a * 255;
  }
  return out;
}

function fromPremul(f: Float32Array, w: number, h: number): ImageData {
  const out = new Uint8ClampedArray(f.length);
  for (let i = 0; i < f.length; i += 4) {
    const a = (f[i + 3] as number) / 255;
    if (a <= 0.0001) continue;
    out[i] = (f[i] as number) / a;
    out[i + 1] = (f[i + 1] as number) / a;
    out[i + 2] = (f[i + 2] as number) / a;
    out[i + 3] = f[i + 3] as number;
  }
  return makeImageData(w, h, out);
}

function kernel(radius: number): Float32Array {
  const r = Math.max(1, Math.ceil(radius * 2));
  const k = new Float32Array(2 * r + 1);
  const s = Math.max(0.3, radius);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * s * s));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] = (k[i] as number) / sum;
  return k;
}

function blurPremul(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (radius <= 0) return src;
  const k = kernel(radius);
  const r = (k.length - 1) / 2;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      let b = 0;
      let c = 0;
      let d = 0;
      for (let i = -r; i <= r; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        const o = (y * w + xx) * 4;
        const wt = k[i + r] as number;
        a += (src[o] as number) * wt;
        b += (src[o + 1] as number) * wt;
        c += (src[o + 2] as number) * wt;
        d += (src[o + 3] as number) * wt;
      }
      const o = (y * w + x) * 4;
      tmp[o] = a;
      tmp[o + 1] = b;
      tmp[o + 2] = c;
      tmp[o + 3] = d;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      let b = 0;
      let c = 0;
      let d = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        const o = (yy * w + x) * 4;
        const wt = k[i + r] as number;
        a += (tmp[o] as number) * wt;
        b += (tmp[o + 1] as number) * wt;
        c += (tmp[o + 2] as number) * wt;
        d += (tmp[o + 3] as number) * wt;
      }
      const o = (y * w + x) * 4;
      out[o] = a;
      out[o + 1] = b;
      out[o + 2] = c;
      out[o + 3] = d;
    }
  }
  return out;
}

/** Gaussian blur with standard deviation `radius` px. */
export function gaussianBlur(img: Img, radius: number): ImageData {
  return fromPremul(blurPremul(toPremul(img), img.width, img.height, radius), img.width, img.height);
}

/** Blur along a line of `distance` px at `angle` degrees (centred). */
export function motionBlur(img: Img, angle: number, distance: number): ImageData {
  const { width: w, height: h } = img;
  const src = toPremul(img);
  const n = Math.max(1, Math.round(distance));
  const dx = Math.cos((angle * Math.PI) / 180);
  const dy = Math.sin((angle * Math.PI) / 180);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      let b = 0;
      let c = 0;
      let d = 0;
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : i / (n - 1) - 0.5;
        const xx = Math.min(w - 1, Math.max(0, Math.round(x + dx * t * distance)));
        const yy = Math.min(h - 1, Math.max(0, Math.round(y + dy * t * distance)));
        const o = (yy * w + xx) * 4;
        a += src[o] as number;
        b += src[o + 1] as number;
        c += src[o + 2] as number;
        d += src[o + 3] as number;
      }
      const o = (y * w + x) * 4;
      out[o] = a / n;
      out[o + 1] = b / n;
      out[o + 2] = c / n;
      out[o + 3] = d / n;
    }
  }
  return fromPremul(out, w, h);
}

/** Unsharp mask: amount 0..3, radius px. */
export function sharpen(img: Img, amount: number, radius: number): ImageData {
  const src = toPremul(img);
  const blur = blurPremul(src, img.width, img.height, Math.max(0.5, radius));
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    for (let c = 0; c < 3; c++) out[i + c] = Math.max(0, (src[i + c] as number) + ((src[i + c] as number) - (blur[i + c] as number)) * amount);
    out[i + 3] = src[i + 3] as number;
    // Premultiplied colour can't exceed alpha.
    for (let c = 0; c < 3; c++) out[i + c] = Math.min(out[i + c] as number, out[i + 3] as number);
  }
  return fromPremul(out, img.width, img.height);
}

export interface NoiseParams {
  /** 0..1 */
  amount: number;
  /** Same grain on every channel. */
  mono: boolean;
  seed: number;
}

/** Seeded film grain: the same seed gives the same noise. */
export function noise(img: Img, p: NoiseParams): ImageData {
  const out = new Uint8ClampedArray(img.data);
  const rng = createRng(p.seed);
  const k = p.amount * 128;
  for (let i = 0; i < out.length; i += 4) {
    const a = rng();
    const b = p.mono ? a : rng();
    const c = p.mono ? a : rng();
    if (out[i + 3] === 0) continue;
    out[i] = (out[i] as number) + (a - 0.5) * 2 * k;
    out[i + 1] = (out[i + 1] as number) + (b - 0.5) * 2 * k;
    out[i + 2] = (out[i + 2] as number) + (c - 0.5) * 2 * k;
  }
  return makeImageData(img.width, img.height, out);
}
