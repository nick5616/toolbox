/**
 * Pixel sampling of a source image (Phase 21 B5, `EditEngine.samplePre`): the
 * average of an n x n box around a UV, clamped into the image. Pure and
 * GL-free; the engine supplies `read` (a framebuffer readPixels in the app, an
 * array in tests).
 */

/** Reads the RGBA8 block [x, x + w) x [y, y + h) of the image, rows top-down, 4 bytes per pixel. */
export type BoxReader = (x: number, y: number, w: number, h: number) => Uint8Array | Uint8ClampedArray;

export interface SampleBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The size x size pixel box centred on (u, v) (0..1, v from the top), shifted to stay inside a w x h image. */
export function sampleBox(w: number, h: number, u: number, v: number, size = 5): SampleBox {
  const bw = Math.min(size, w);
  const bh = Math.min(size, h);
  const cx = Math.floor(Math.min(1, Math.max(0, u)) * w);
  const cy = Math.floor(Math.min(1, Math.max(0, v)) * h);
  const x = Math.max(0, Math.min(w - bw, cx - (bw >> 1)));
  const y = Math.max(0, Math.min(h - bh, cy - (bh >> 1)));
  return { x, y, w: bw, h: bh };
}

/** Mean RGB (0..1, as stored: sRGB-encoded) of RGBA8 pixels. */
export function averageRGB(px: ArrayLike<number>, count: number): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < count; i++) {
    r += px[i * 4] as number;
    g += px[i * 4 + 1] as number;
    b += px[i * 4 + 2] as number;
  }
  const d = Math.max(1, count) * 255;
  return [r / d, g / d, b / d];
}

/** The clip's own source pixel at (u, v), averaged over `size` x `size`. */
export function samplePixels(w: number, h: number, u: number, v: number, read: BoxReader, size = 5): [number, number, number] | null {
  if (w <= 0 || h <= 0) return null;
  const box = sampleBox(w, h, u, v, size);
  const px = read(box.x, box.y, box.w, box.h);
  if (px.length < box.w * box.h * 4) return null;
  return averageRGB(px, box.w * box.h);
}
