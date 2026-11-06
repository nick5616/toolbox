/** Canvas limits (SPEC §2.2, §4): mirrored from modules/paint (MaxSide, MaxPixels). */
export const MAX_SIDE = 8192;
export const MAX_PIXELS = 40_000_000;

export interface CanvasPreset {
  id: string;
  label: string;
  note: string;
  w: number;
  h: number;
}

/** New-canvas presets, 16:9 first (SPEC §1.1 item 1). */
export const PRESETS: CanvasPreset[] = [
  { id: "hd", label: "Screen 16:9", note: "Full HD", w: 1920, h: 1080 },
  { id: "qhd", label: "Screen 16:9", note: "QHD", w: 2560, h: 1440 },
  { id: "uhd", label: "Screen 16:9", note: "4K", w: 3840, h: 2160 },
  { id: "square", label: "Square", note: "2048", w: 2048, h: 2048 },
  { id: "portrait", label: "Portrait 9:16", note: "Phone, 4K tall", w: 2160, h: 3840 },
  { id: "a4", label: "A4, 300 dpi", note: "Print", w: 2480, h: 3508 },
];

export function sizeProblem(w: number, h: number): string {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return "Width and height must be at least 1 px";
  if (w > MAX_SIDE || h > MAX_SIDE) return `Each side can be at most ${MAX_SIDE} px`;
  if (w * h > MAX_PIXELS) return `A canvas can be at most ${MAX_PIXELS / 1e6} megapixels (this one is ${((w * h) / 1e6).toFixed(1)})`;
  return "";
}

/** The size an over-limit image is scaled to by "Scale down to fit". */
export function fitSize(w: number, h: number): { w: number; h: number } {
  const k = Math.min(1, MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
  return { w: Math.max(1, Math.floor(w * k)), h: Math.max(1, Math.floor(h * k)) };
}

export const IMAGE_PICK_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".ora"];

export const isOra = (path: string): boolean => /\.ora$/i.test(path);

export function baseNameNoExt(path: string): string {
  const base = path.split(/[\\/]+/).filter(Boolean).pop() ?? path;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(0, i) : base;
}
