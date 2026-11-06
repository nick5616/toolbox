// Pure pixel helpers for the perception tools. They work on anything shaped
// like ImageData ({width, height, data}) so tests run without a canvas.
// No Math.random, Date or performance.now (determinism rules).

import type { Rect } from "../engine/types";

/** ImageData in the browser, a structural stand-in under jsdom. */
export function createImage(w: number, h: number, data?: Uint8ClampedArray): ImageData {
  const buf = data ?? new Uint8ClampedArray(w * h * 4);
  if (typeof ImageData !== "undefined") {
    return new ImageData(new Uint8ClampedArray(buf), w, h);
  }
  return { width: w, height: h, data: buf, colorSpace: "srgb" } as ImageData;
}

export function cloneImage(img: ImageData): ImageData {
  return createImage(img.width, img.height, new Uint8ClampedArray(img.data));
}

/** Crops img to r (in img px). Pixels outside the image stay transparent. */
export function cropImage(img: ImageData, r: Rect): ImageData {
  const out = createImage(r.w, r.h);
  for (let y = 0; y < r.h; y++) {
    const sy = r.y + y;
    if (sy < 0 || sy >= img.height) continue;
    for (let x = 0; x < r.w; x++) {
      const sx = r.x + x;
      if (sx < 0 || sx >= img.width) continue;
      const s = (sy * img.width + sx) * 4;
      const d = (y * r.w + x) * 4;
      out.data[d] = img.data[s]!;
      out.data[d + 1] = img.data[s + 1]!;
      out.data[d + 2] = img.data[s + 2]!;
      out.data[d + 3] = img.data[s + 3]!;
    }
  }
  return out;
}

/** Overwrites dst with src at (x, y); parts outside dst are dropped. */
export function pasteImage(dst: ImageData, src: ImageData, x: number, y: number): void {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= dst.height) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= dst.width) continue;
      const s = (sy * src.width + sx) * 4;
      const d = (dy * dst.width + dx) * 4;
      dst.data[d] = src.data[s]!;
      dst.data[d + 1] = src.data[s + 1]!;
      dst.data[d + 2] = src.data[s + 2]!;
      dst.data[d + 3] = src.data[s + 3]!;
    }
  }
}

/** Bilinear resample (alpha-weighted so transparent edges don't bleed colour). */
export function resizeBilinear(img: ImageData, w: number, h: number): ImageData {
  if (img.width === w && img.height === h) return cloneImage(img);
  const out = createImage(w, h);
  const sw = img.width;
  const sh = img.height;
  const fx = sw / w;
  const fy = sh / h;
  for (let y = 0; y < h; y++) {
    const gy = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = gx - x0;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const a00 = img.data[i00 + 3]! * w00;
      const a10 = img.data[i10 + 3]! * w10;
      const a01 = img.data[i01 + 3]! * w01;
      const a11 = img.data[i11 + 3]! * w11;
      const a = a00 + a10 + a01 + a11;
      const o = (y * w + x) * 4;
      if (a > 0) {
        for (let c = 0; c < 3; c++) {
          out.data[o + c] =
            (img.data[i00 + c]! * a00 + img.data[i10 + c]! * a10 + img.data[i01 + c]! * a01 + img.data[i11 + c]! * a11) / a;
        }
      }
      out.data[o + 3] = a;
    }
  }
  return out;
}

/** Tight box around pixels whose alpha is above `threshold`, or null. */
export function alphaBounds(img: ImageData, threshold = 0): Rect | null {
  let x0 = img.width;
  let y0 = img.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3]! > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Alpha channel as 0..1 floats. */
export function alphaOf(img: ImageData): Float32Array {
  const a = new Float32Array(img.width * img.height);
  for (let i = 0; i < a.length; i++) a[i] = img.data[i * 4 + 3]! / 255;
  return a;
}

/** A white image whose alpha is `a`. */
export function maskFromAlpha(a: Float32Array, w: number, h: number): ImageData {
  const out = createImage(w, h);
  for (let i = 0; i < a.length; i++) {
    const o = i * 4;
    out.data[o] = 255;
    out.data[o + 1] = 255;
    out.data[o + 2] = 255;
    out.data[o + 3] = Math.round(Math.max(0, Math.min(1, a[i]!)) * 255);
  }
  return out;
}

/** Places `mask` into a transparent cropW×cropH image at (atX, atY). */
export function embedMask(mask: ImageData, cropW: number, cropH: number, atX: number, atY: number): ImageData {
  const out = createImage(cropW, cropH);
  pasteImage(out, mask, atX, atY);
  return out;
}

function boxBlur1D(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean): void {
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const win = 2 * r + 1;
  for (let l = 0; l < lines; l++) {
    const idx = (i: number) => (horizontal ? l * w + i : i * w + l);
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[idx(Math.min(len - 1, Math.max(0, i)))]!;
    for (let i = 0; i < len; i++) {
      dst[idx(i)] = sum / win;
      sum += src[idx(Math.min(len - 1, i + r + 1))]! - src[idx(Math.max(0, i - r))]!;
    }
  }
}

/** Soft edge: two box-blur passes on the alpha (about a triangle kernel of width 2·px). */
export function featherAlpha(a: Float32Array, w: number, h: number, px: number): Float32Array {
  const r = Math.max(0, Math.floor(px / 2));
  if (r === 0) return a.slice();
  let cur = a;
  const tmp = new Float32Array(a.length);
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(a.length);
    boxBlur1D(cur, tmp, w, h, r, true);
    boxBlur1D(tmp, out, w, h, r, false);
    cur = out;
  }
  return cur;
}

/** dst = lerp(dst, src, weight) per pixel (straight alpha, weight 0..1). */
export function blendInto(dst: ImageData, src: ImageData, weight: Float32Array): void {
  for (let i = 0; i < weight.length; i++) {
    const wt = weight[i]!;
    if (wt <= 0) continue;
    const o = i * 4;
    for (let c = 0; c < 4; c++) dst.data[o + c] = dst.data[o + c]! * (1 - wt) + src.data[o + c]! * wt;
  }
}

export function imagesEqual(a: ImageData, b: ImageData): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

/** Grow (r > 0) or shrink (r < 0) a 0..1 mask by |r| steps of a 3×3 neighbourhood. */
export function morph(a: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r === 0) return a.slice();
  const grow = r > 0;
  let cur = a;
  for (let step = 0; step < Math.abs(r); step++) {
    const next = new Float32Array(cur.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = grow ? 0 : 1;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            const s = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : cur[yy * w + xx]!;
            v = grow ? Math.max(v, s) : Math.min(v, s);
          }
        }
        next[y * w + x] = v;
      }
    }
    cur = next;
  }
  return cur;
}
