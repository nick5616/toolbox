/** Small helpers shared by VisualsCanvas and PresetThumbs. */

export const MAX_LONG_SIDE = 1920;

/** Pixel size of the largest `aspect` rectangle inside a CSS box, times dpr, capped. */
export function fitSize(boxW: number, boxH: number, aspect: number, dpr: number, maxLong = MAX_LONG_SIDE): { cssW: number; cssH: number; w: number; h: number } {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9;
  let cssW = Math.max(1, boxW);
  let cssH = cssW / a;
  if (cssH > boxH && boxH > 0) {
    cssH = boxH;
    cssW = cssH * a;
  }
  let w = cssW * Math.max(1, dpr);
  let h = cssH * Math.max(1, dpr);
  const long = Math.max(w, h);
  if (long > maxLong) {
    w = (w * maxLong) / long;
    h = (h * maxLong) / long;
  }
  return { cssW, cssH, w: Math.max(2, Math.round(w)), h: Math.max(2, Math.round(h)) };
}

/** Fetches an image through the media route as a bitmap. */
export async function loadBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image ${res.status}`);
  return createImageBitmap(await res.blob());
}

let scratch: HTMLCanvasElement | null = null;

/**
 * Overlay frames come packed (colour on the top half, alpha on the bottom half
 * of a W × 2H canvas). This unpacks one into a normal RGBA canvas.
 */
export function drawOverlay(src: CanvasImageSource, dst: CanvasRenderingContext2D, w: number, h: number): void {
  scratch ??= document.createElement("canvas");
  scratch.width = w;
  scratch.height = h * 2;
  const sc = scratch.getContext("2d", { willReadFrequently: true });
  if (!sc) return;
  sc.drawImage(src, 0, 0, w, h * 2);
  const top = sc.getImageData(0, 0, w, h);
  const bottom = sc.getImageData(0, h, w, h);
  const t = top.data;
  const b = bottom.data;
  for (let i = 0; i < t.length; i += 4) t[i + 3] = b[i] ?? 0;
  dst.putImageData(top, 0, 0);
}

/** Start (ms) of the loudest `windowMs` stretch of an analysis, by mix level. */
export function loudestWindow(a: { fps: number; channel(id: string): Float32Array | null }, windowMs = 8000): number {
  const ch = a.channel("mix.level");
  const win = Math.round((windowMs / 1000) * a.fps);
  if (!ch || ch.length <= win || win <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < win; i++) sum += ch[i] ?? 0;
  let best = sum;
  let bestAt = 0;
  for (let i = win; i < ch.length; i++) {
    sum += (ch[i] ?? 0) - (ch[i - win] ?? 0);
    if (sum > best) {
      best = sum;
      bestAt = i - win + 1;
    }
  }
  return Math.round((bestAt / a.fps) * 1000);
}

/** Thumbnail pixel size: 320 on the long side at the given aspect. */
export function thumbSize(aspect: number, long = 320): { w: number; h: number } {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9;
  return a >= 1 ? { w: long, h: Math.max(2, Math.round(long / a)) } : { w: Math.max(2, Math.round(long * a)), h: long };
}
