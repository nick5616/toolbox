import { UpscaleDevice, UpscaleFormat, UpscaleModel, type UpscaleLimits, type UpscaleOptions } from "@/lib/api";
import type { JobView } from "@/state/jobs";
import { basename, num, parseJson, str } from "../image/common";
import type { ResultItem } from "../image/ResultCards";

/** Mirrors Go's DefaultOptions() (modules/upscale). */
export const DEFAULT_UPSCALE_OPTIONS: UpscaleOptions = {
  model: UpscaleModel.ModelPhoto,
  scale: 4,
  format: UpscaleFormat.FormatSame,
  device: UpscaleDevice.DeviceAuto,
};

function oneOf<T extends string>(enumObj: Record<string, T>, v: unknown): T | undefined {
  return typeof v === "string" && v !== "" && Object.values(enumObj).includes(v as T) ? (v as T) : undefined;
}

export function sanitizeUpscaleOptions(raw: unknown, defaults: UpscaleOptions): UpscaleOptions {
  const out: UpscaleOptions = { ...defaults };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  out.model = oneOf(UpscaleModel, r.model) ?? out.model;
  out.format = oneOf(UpscaleFormat, r.format) ?? out.format;
  out.device = oneOf(UpscaleDevice, r.device) ?? out.device;
  if (r.scale === 2 || r.scale === 4) out.scale = r.scale;
  return out;
}

export interface ImageDims {
  w: number;
  h: number;
}

export type RowVerdict =
  | { kind: "unknown" }
  | { kind: "heic" }
  | { kind: "ok"; outW: number; outH: number }
  | { kind: "over"; outW: number; outH: number; reason: string };

/** Classifies one input for the current scale/device against the pixel caps. `dims` is null for HEIC/unreadable. */
export function rowVerdict(
  dims: ImageDims | "heic" | undefined,
  scale: number,
  device: UpscaleDevice,
  limits: UpscaleLimits | null,
): RowVerdict {
  if (dims === undefined) return { kind: "unknown" };
  if (dims === "heic") return { kind: "heic" };
  const outW = dims.w * scale;
  const outH = dims.h * scale;
  if (limits) {
    if (outW * outH > limits.maxOutputPixels) {
      return { kind: "over", outW, outH, reason: `Too large to upscale ${scale}× (max ${Math.round(limits.maxOutputPixels / 1e6)} MP output)` };
    }
    if (device === UpscaleDevice.DeviceCPU && dims.w * dims.h > limits.maxCpuInputPixels) {
      return { kind: "over", outW, outH, reason: `Too large for CPU upscaling (max ${limits.maxCpuInputPixels / 1e6} MP input)` };
    }
  }
  return { kind: "ok", outW, outH };
}

/** Estimated CPU seconds for the given inputs (input megapixels x seconds per MP). */
export function cpuEstimateSeconds(dims: ImageDims[], secondsPerMPixel: number): number {
  const mp = dims.reduce((n, d) => n + (d.w * d.h) / 1e6, 0);
  return mp * secondsPerMPixel;
}

export function formatEstimate(sec: number): string {
  if (sec < 1) return "under a second";
  if (sec < 90) return `about ${Math.round(sec)} s`;
  return `about ${Math.round(sec / 60)} min`;
}

/** Result card for a finished job; null when the result is missing. */
export function toResultItem(job: JobView): ResultItem | null {
  const r = parseJson(job.resultJson);
  const output = r ? str(r.output) : "";
  const original = job.inputs[0];
  if (!r || !output || !original) return null;
  const iw = num(r.inWidth);
  const ih = num(r.inHeight);
  const ow = num(r.outWidth);
  const oh = num(r.outHeight);
  const device = str(r.device);
  const meta = [
    iw && ih && ow && oh ? `${iw}×${ih} → ${ow}×${oh}` : "",
    device === "cpu" ? "CPU" : device === "mps" ? "GPU (Metal)" : device === "gpu" ? "GPU" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const out = job.outputs.find((o) => o.path === output);
  return {
    id: job.id,
    original,
    output,
    outputId: out?.id,
    missing: out?.missing,
    title: basename(output),
    meta,
    aspect: ow > 0 && oh > 0 ? ow / oh : 4 / 3,
    checkerboard: true,
    afterLabel: "Upscaled",
  };
}
