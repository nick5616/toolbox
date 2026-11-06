import { GifMode, type GifOptions } from "@/lib/api";
import type { JobView } from "@/state/jobs";
import { basename, num, parseJson, str } from "@/tools/_kit/image/common";

/** Mirrors Go's DefaultOptions() (modules/gif). */
export const DEFAULT_GIF_OPTIONS: GifOptions = {
  mode: GifMode.ModeGIF,
  startSec: 0,
  lengthSec: 5,
  fps: 12,
  width: 480,
  loop: true,
  columns: 4,
  rows: 4,
  cellWidth: 320,
  labels: true,
};

function clamp(v: unknown, lo: number, hi: number, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
}

/** `sanitize` for useModuleOptions: saved values over the defaults, out-of-range ones clamped. */
export function sanitizeGifOptions(raw: unknown, defaults: GifOptions): GifOptions {
  const out: GifOptions = { ...defaults };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  const modes: string[] = Object.values(GifMode);
  if (typeof r.mode === "string" && r.mode !== "" && modes.includes(r.mode)) out.mode = r.mode as GifMode;
  out.startSec = clamp(r.startSec, 0, 36000, out.startSec);
  out.lengthSec = clamp(r.lengthSec, 0.5, 30, out.lengthSec);
  out.fps = Math.round(clamp(r.fps, 1, 30, out.fps));
  out.width = Math.round(clamp(r.width, 120, 1280, out.width));
  if (typeof r.loop === "boolean") out.loop = r.loop;
  out.columns = Math.round(clamp(r.columns, 1, 10, out.columns));
  out.rows = Math.round(clamp(r.rows, 1, 10, out.rows));
  while (out.columns * out.rows > 100) out.rows -= 1;
  out.cellWidth = Math.round(clamp(r.cellWidth, 120, 1280, out.cellWidth));
  if (typeof r.labels === "boolean") out.labels = r.labels;
  return out;
}

export interface GifResultItem {
  id: string;
  title: string;
  mode: GifMode;
  path: string;
  outputId: string;
  missing: boolean;
  name: string;
  sizeBytes: number;
  meta: string;
}

/** Result card data for a finished job; null when the result is missing. */
export function toGifResult(job: JobView): GifResultItem | null {
  const r = parseJson(job.resultJson);
  if (!r) return null;
  const outs = Array.isArray(r.outputs) ? r.outputs.filter((p): p is string => typeof p === "string") : [];
  const path = outs[0] ?? job.outputs[0]?.path ?? "";
  if (path === "") return null;
  const out = job.outputs.find((o) => o.path === path);
  const mode = str(r.mode) === "webp" ? GifMode.ModeWebP : str(r.mode) === "sheet" ? GifMode.ModeSheet : GifMode.ModeGIF;
  const sizeBytes = num(r.sizeBytes);
  const parts: string[] = [];
  if (mode === GifMode.ModeSheet) {
    const n = num(r.frames);
    parts.push(`${n} ${n === 1 ? "frame" : "frames"}`);
  } else {
    parts.push(`${(num(r.durationMs) / 1000).toFixed(1)} s`);
    if (num(r.width) > 0) parts.push(`${num(r.width)} × ${num(r.height)}`);
  }
  if (sizeBytes > 0) parts.push(formatSize(sizeBytes));
  const input = job.inputs[0];
  return {
    id: job.id,
    title: input ? basename(input) : job.title,
    mode,
    path,
    outputId: out?.id ?? "",
    missing: out?.missing ?? false,
    name: basename(path),
    sizeBytes,
    meta: parts.join(" · "),
  };
}

export function formatSize(bytes: number): string {
  return bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The summary line of the Advanced click-in. */
export function gifSummary(o: GifOptions): string {
  if (o.mode === GifMode.ModeSheet) return `${o.cellWidth} px frames${o.labels ? " · timecodes" : ""}`;
  return `${o.fps} fps · ${o.width} px${o.loop ? "" : " · plays once"}`;
}

/** Seconds rounded to a tenth (what the Start field shows). */
export function tenthsOfSecond(sec: number): number {
  return Math.max(0, Math.round(sec * 10) / 10);
}

/** The loop length that ends at `endSec`, clamped to 0.5..30 s; null when the end is not after the start. */
export function lengthFromEnd(startSec: number, endSec: number): number | null {
  const len = tenthsOfSecond(endSec) - startSec;
  if (!(len > 0)) return null;
  return Math.min(30, Math.max(0.5, Math.round(len * 10) / 10));
}
