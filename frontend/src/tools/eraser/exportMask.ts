import { exportSize } from "./mask";

/**
 * Exports the painted mask as a PNG data URL at the image's natural resolution
 * (capped at 8192 px): white where painted, black elsewhere. Returns "" when the
 * canvas can't be drawn on.
 */
export function exportMaskPNG(mask: HTMLCanvasElement, naturalW: number, naturalH: number): string {
  const size = exportSize(naturalW, naturalH);
  const out = document.createElement("canvas");
  out.width = size.w;
  out.height = size.h;
  const ctx = out.getContext("2d");
  if (!ctx) return "";
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(mask, 0, 0, size.w, size.h);
  // Whatever was painted (any colour or alpha) becomes opaque white, the rest black.
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size.w, size.h);
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, size.w, size.h);
  return out.toDataURL("image/png");
}

/** True when nothing is painted on the canvas. */
export function canvasIsEmpty(mask: HTMLCanvasElement, check: (d: Uint8ClampedArray) => boolean): boolean {
  const ctx = mask.getContext("2d");
  if (!ctx || mask.width === 0 || mask.height === 0) return true;
  return check(ctx.getImageData(0, 0, mask.width, mask.height).data);
}
