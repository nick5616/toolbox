import {
  BatchCorner,
  BatchFit,
  BatchFormat,
  BatchResize,
  BatchWatermarkKind,
  type ImageBatchOptions,
  type ImageBatchWatermark,
} from "@/lib/api";
import { num, parseJson, str } from "@/tools/_kit/image/common";

export const ASPECTS = ["1:1", "4:5", "5:4", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"] as const;
export const FALLBACK_FONTS = ["Arial", "Verdana", "Georgia", "Trebuchet MS", "Impact", "Courier New"] as const;
export const SIDE_LIMITS = { min: 16, max: 20_000 } as const;

/** Mirrors Go's DefaultWatermark(). */
export const DEFAULT_WATERMARK: ImageBatchWatermark = {
  kind: BatchWatermarkKind.WatermarkNone,
  text: "",
  font: "Arial",
  color: "#ffffff",
  logo: "",
  corner: BatchCorner.CornerBottomRight,
  opacity: 0.6,
  size: 5,
};

/** Mirrors Go's DefaultOptions() (modules/imagebatch). */
export const DEFAULT_BATCH_OPTIONS: ImageBatchOptions = {
  resize: BatchResize.ResizeLongSide,
  longSide: 2048,
  noEnlarge: true,
  width: 1080,
  height: 1080,
  aspect: "",
  fit: BatchFit.FitCrop,
  background: "#ffffff",
  format: BatchFormat.FormatJPG,
  quality: 85,
  strip: true,
  watermark: DEFAULT_WATERMARK,
  name: "{name}",
};

function oneOf<T extends string>(enumObj: Record<string, T>, v: unknown): T | undefined {
  return typeof v === "string" && v !== "" && Object.values(enumObj).includes(v as T) ? (v as T) : undefined;
}

function clampInt(v: unknown, d: number, lo: number, hi: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : d;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export function sanitizeWatermark(raw: unknown, d: ImageBatchWatermark): ImageBatchWatermark {
  const out = { ...d };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  out.kind = oneOf(BatchWatermarkKind, r.kind) ?? out.kind;
  out.text = typeof r.text === "string" ? r.text.slice(0, 200) : out.text;
  out.font = typeof r.font === "string" && r.font !== "" ? r.font : out.font;
  out.color = typeof r.color === "string" && HEX.test(r.color) ? r.color.toLowerCase() : out.color;
  out.logo = typeof r.logo === "string" ? r.logo : out.logo;
  out.corner = oneOf(BatchCorner, r.corner) ?? out.corner;
  if (typeof r.opacity === "number" && Number.isFinite(r.opacity)) out.opacity = Math.min(1, Math.max(0.05, r.opacity));
  if (typeof r.size === "number" && Number.isFinite(r.size)) out.size = Math.min(60, Math.max(2, r.size));
  return out;
}

/** `sanitize` for useModuleOptions: valid fields over the defaults. */
export function sanitizeBatchOptions(raw: unknown, defaults: ImageBatchOptions): ImageBatchOptions {
  const out: ImageBatchOptions = { ...defaults, watermark: { ...defaults.watermark } };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  out.resize = oneOf(BatchResize, r.resize) ?? out.resize;
  out.longSide = clampInt(r.longSide, out.longSide, SIDE_LIMITS.min, SIDE_LIMITS.max);
  if (typeof r.noEnlarge === "boolean") out.noEnlarge = r.noEnlarge;
  out.width = clampInt(r.width, out.width, 1, SIDE_LIMITS.max);
  out.height = clampInt(r.height, out.height, 1, SIDE_LIMITS.max);
  if (typeof r.aspect === "string" && (r.aspect === "" || (ASPECTS as readonly string[]).includes(r.aspect))) out.aspect = r.aspect;
  out.fit = oneOf(BatchFit, r.fit) ?? out.fit;
  if (typeof r.background === "string" && (r.background === "transparent" || HEX.test(r.background))) out.background = r.background.toLowerCase();
  out.format = oneOf(BatchFormat, r.format) ?? out.format;
  out.quality = clampInt(r.quality, out.quality, 1, 100);
  if (typeof r.strip === "boolean") out.strip = r.strip;
  out.watermark = sanitizeWatermark(r.watermark, out.watermark);
  if (typeof r.name === "string" && r.name.length <= 200) out.name = r.name;
  return out;
}

/** Why the options can't be run yet ("" when they can). */
export function optionsProblem(o: ImageBatchOptions): string {
  const w = o.watermark;
  if (w.kind === BatchWatermarkKind.WatermarkText && w.text.trim() === "") return "Type the watermark text";
  if (w.kind === BatchWatermarkKind.WatermarkLogo && w.logo === "") return "Choose the logo image";
  return "";
}

/** One line for the Advanced row. */
export function advancedSummary(o: ImageBatchOptions): string {
  const parts: string[] = [];
  if (o.resize !== BatchResize.ResizeExact && o.aspect !== "") parts.push(`${o.aspect} ${o.fit}`);
  parts.push(o.format === BatchFormat.FormatSame ? "same type" : o.format.toUpperCase());
  if (o.format !== BatchFormat.FormatPNG) parts.push(`quality ${o.quality}`);
  if (o.watermark.kind !== BatchWatermarkKind.WatermarkNone) parts.push(`${o.watermark.kind} watermark`);
  parts.push(o.strip ? "no metadata" : "keep metadata");
  if (o.name !== "{name}") parts.push(`name ${o.name}`);
  return parts.join(" · ");
}

/** Changes whenever the preview would look different. */
export function previewKey(path: string, o: ImageBatchOptions): string {
  const visible = { ...o, quality: 0, strip: false, name: "" };
  return `${path}\u0000${JSON.stringify(visible)}`;
}

/** "1920 × 1080 · 410 KB" for a finished file. */
export interface BatchFileOutcome {
  input: string;
  output: string;
  width: number;
  height: number;
  bytes: number;
}

export function parseBatch(json: string | null | undefined): { files: BatchFileOutcome[]; failed: string[] } {
  const r = parseJson(json);
  const files: BatchFileOutcome[] = [];
  const failed: string[] = [];
  if (!r) return { files, failed };
  if (Array.isArray(r.files)) {
    for (const f of r.files) {
      if (typeof f !== "object" || f === null) continue;
      const o = f as Record<string, unknown>;
      if (!str(o.output)) continue;
      files.push({ input: str(o.input), output: str(o.output), width: num(o.width), height: num(o.height), bytes: num(o.bytes) });
    }
  }
  if (Array.isArray(r.failed)) for (const m of r.failed) if (typeof m === "string") failed.push(m);
  return { files, failed };
}
