// Wet bleed: after a stroke, its paint spreads a little, settled over 600 ms.
// We run the settle on fixed ticks (12 × 50 ms), never wall time, on the
// stroke's own pixels (its scratch) so existing art under it is untouched.

import type { PixelBuf } from "../engine/pixels";

export const BLEED_TICKS = 12;

/** How far the bleed can reach (px) for a given amount, so callers pad the region. */
export function bleedMargin(amount: number, ticks = BLEED_TICKS): number {
  return amount > 0 ? Math.ceil(ticks * 1) + 1 : 0;
}

/** One diffusion tick on a premultiplied buffer: a [1 2 1] blur mixed in by `k`. */
export function bleedTick(buf: PixelBuf, k: number, tmp?: Float32Array): void {
  const { w, h, data } = buf;
  const t = tmp && tmp.length >= data.length ? tmp : new Float32Array(data.length);
  // Horizontal.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const l = x > 0 ? o - 4 : o;
      const r = x < w - 1 ? o + 4 : o;
      for (let c = 0; c < 4; c++) t[o + c] = ((data[l + c] as number) + 2 * (data[o + c] as number) + (data[r + c] as number)) * 0.25;
    }
  }
  // Vertical, mixed with the original.
  for (let y = 0; y < h; y++) {
    const up = y > 0 ? y - 1 : y;
    const dn = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const u = (up * w + x) * 4;
      const d = (dn * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        const blurred = ((t[u + c] as number) + 2 * (t[o + c] as number) + (t[d + c] as number)) * 0.25;
        const cur = data[o + c] as number;
        data[o + c] = cur + (blurred - cur) * k;
      }
    }
  }
}

/** Run the whole settle. `amount` 0..1 is the preset's wet.bleed. */
export function bleed(buf: PixelBuf, amount: number, ticks = BLEED_TICKS): void {
  if (amount <= 0) return;
  const k = Math.min(0.6, 0.15 + amount * 0.4);
  const tmp = new Float32Array(buf.data.length);
  for (let i = 0; i < ticks; i++) bleedTick(buf, k, tmp);
}
