import { maskToPaint, type Size } from "./mask";

/**
 * Decodes a saved mask's PNG data URL into a canvas of `size` (the photo's
 * painting canvas), painted in `rgb` where the mask is white. Resolves null
 * when the image can't be decoded or drawn.
 */
export function loadMaskStamp(dataUrl: string, size: Size, rgb: [number, number, number]): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = size.w;
      c.height = size.h;
      const ctx = c.getContext("2d");
      if (!ctx) return resolve(null);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, 0, 0, size.w, size.h);
      const px = ctx.getImageData(0, 0, size.w, size.h);
      maskToPaint(px.data, rgb);
      ctx.putImageData(px, 0, 0);
      resolve(c);
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/** Parses "rgb(r, g, b)" / "#rrggbb" into channels (white when unknown). */
export function parseColor(css: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (hex?.[1]) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i.exec(css);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return [255, 255, 255];
}
