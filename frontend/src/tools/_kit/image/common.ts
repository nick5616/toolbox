import { clearThumbs, useThumbState } from "@/lib/thumbs";
import { toAppError } from "@/lib/errors";

export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** HEIC/HEIF photos (converted to PNG by Go's core/heic for previews). */
export function isHeic(path: string): boolean {
  return /\.(heic|heif)$/i.test(path);
}

/** Parses a job's resultJson into an object; null when missing or malformed. */
export function parseJson(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export type ThumbState =
  | { status: "loading" }
  | { status: "ok"; src: string }
  | { status: "heic" }
  | { status: "error"; message: string };

/**
 * Loads an ImageThumb data URL through the shared queue and cache; HEIC is converted by Go (a tile if it can't be).
 * Pass `enabled` = the `seen` flag of `useInView` so off-screen cards don't load.
 */
export function useThumb(path: string, maxDim: number, enabled = true): ThumbState {
  const t = useThumbState(path, maxDim, enabled);
  if (t.status !== "error") return t;
  // HEIC that can't be converted (no FFmpeg or engine) falls back to a tile.
  return isHeic(path) ? { status: "heic" } : { status: "error", message: toAppError(t.error).message };
}

export function clearThumbCache(): void {
  clearThumbs();
}

/** Display text for megapixels, e.g. "12.3 MP". */
export function formatMegapixels(px: number): string {
  return `${(px / 1e6).toFixed(px >= 1e7 ? 0 : 1)} MP`;
}
