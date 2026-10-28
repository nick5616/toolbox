import { useEffect, useState } from "react";
import { FilesService } from "@/lib/api";
import { toAppError } from "@/lib/errors";

export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** HEIC/HEIF have no Go decoder: no thumbnails, no sizes (SPEC §13.1). */
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

const cache = new Map<string, string>();

/** Loads an `ImageThumb` data URL (cached per path+size). HEIC short-circuits to a tile state. */
export function useThumb(path: string, maxDim: number): ThumbState {
  const key = `${path}\u0000${maxDim}`;
  const [state, setState] = useState<ThumbState>(() => {
    if (isHeic(path)) return { status: "heic" };
    const hit = cache.get(key);
    return hit ? { status: "ok", src: hit } : { status: "loading" };
  });

  useEffect(() => {
    if (isHeic(path)) {
      setState({ status: "heic" });
      return;
    }
    const hit = cache.get(key);
    if (hit) {
      setState({ status: "ok", src: hit });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    FilesService.ImageThumb(path, maxDim)
      .then((src) => {
        if (cache.size > 80) cache.clear();
        cache.set(key, src);
        if (!cancelled) setState({ status: "ok", src });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = toAppError(e);
        setState(/heic/i.test(err.message) ? { status: "heic" } : { status: "error", message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [path, maxDim, key]);

  return state;
}

export function clearThumbCache(): void {
  cache.clear();
}

/** Display text for megapixels, e.g. "12.3 MP". */
export function formatMegapixels(px: number): string {
  return `${(px / 1e6).toFixed(px >= 1e7 ? 0 : 1)} MP`;
}
