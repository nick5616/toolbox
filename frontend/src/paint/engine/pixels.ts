// Pixel buffer helpers shared by the CPU backend, the engine's region ops and
// the adjustments. Surfaces hold PREMULTIPLIED RGBA8; ImageData is straight.

import type { Rect } from "./types";

/** A premultiplied RGBA8 pixel buffer. */
export interface PixelBuf {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

export function newBuf(w: number, h: number): PixelBuf {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}

/** jsdom has no ImageData: fall back to a structurally equal object. */
export function makeImageData(w: number, h: number, data?: Uint8ClampedArray): ImageData {
  const d = data ?? new Uint8ClampedArray(w * h * 4);
  if (typeof ImageData !== "undefined") return new ImageData(d as Uint8ClampedArray<ArrayBuffer>, w, h);
  return { data: d, width: w, height: h, colorSpace: "srgb" } as unknown as ImageData;
}

/** Straight → premultiplied (new buffer). */
export function premultiplied(img: { data: Uint8ClampedArray; width: number; height: number }): PixelBuf {
  const out = newBuf(img.width, img.height);
  const s = img.data;
  const d = out.data;
  for (let i = 0; i < s.length; i += 4) {
    const a = s[i + 3] as number;
    if (a === 255) {
      d[i] = s[i] as number;
      d[i + 1] = s[i + 1] as number;
      d[i + 2] = s[i + 2] as number;
      d[i + 3] = 255;
    } else if (a > 0) {
      d[i] = Math.round(((s[i] as number) * a) / 255);
      d[i + 1] = Math.round(((s[i + 1] as number) * a) / 255);
      d[i + 2] = Math.round(((s[i + 2] as number) * a) / 255);
      d[i + 3] = a;
    }
  }
  return out;
}

/** Premultiplied → straight ImageData. */
export function straightImage(buf: PixelBuf): ImageData {
  const out = new Uint8ClampedArray(buf.data.length);
  const s = buf.data;
  for (let i = 0; i < s.length; i += 4) {
    const a = s[i + 3] as number;
    if (a === 255) {
      out[i] = s[i] as number;
      out[i + 1] = s[i + 1] as number;
      out[i + 2] = s[i + 2] as number;
      out[i + 3] = 255;
    } else if (a > 0) {
      out[i] = Math.min(255, Math.round(((s[i] as number) * 255) / a));
      out[i + 1] = Math.min(255, Math.round(((s[i + 1] as number) * 255) / a));
      out[i + 2] = Math.min(255, Math.round(((s[i + 2] as number) * 255) / a));
      out[i + 3] = a;
    }
  }
  return makeImageData(buf.w, buf.h, out);
}

export function isEmpty(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
  return true;
}

export function rectsIntersect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Copy a sub-rectangle (may extend past the buffer; the excess is transparent) into a new buffer. */
export function cropBuf(src: PixelBuf, r: Rect): PixelBuf {
  const out = newBuf(r.w, r.h);
  for (let y = 0; y < r.h; y++) {
    const sy = r.y + y;
    if (sy < 0 || sy >= src.h) continue;
    const x0 = Math.max(0, -r.x);
    const x1 = Math.min(r.w, src.w - r.x);
    if (x1 <= x0) continue;
    const so = (sy * src.w + r.x + x0) * 4;
    out.data.set(src.data.subarray(so, so + (x1 - x0) * 4), (y * r.w + x0) * 4);
  }
  return out;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Tile key "tx_ty". */
export const tileKey = (tx: number, ty: number): string => `${tx}_${ty}`;

export function parseKey(key: string): [number, number] | null {
  const m = /^(-?\d+)_(-?\d+)$/.exec(key);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
