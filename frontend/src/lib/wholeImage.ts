/**
 * A URL with the whole of a local image for an <img>. Media URLs answer at
 * most 4 MiB per response (CLAUDE.md, Phase 6), and an <img> never asks for
 * the rest, so a big photo showed only its top part. This reads the file in
 * ranges (`fetchAll`) into a blob: URL. Falls back to the media URL when that
 * can't be done (tests, no Blob URLs). Revoke with `releaseImageUrl`.
 */
import { MediaService } from "@/lib/api";
import { fetchAll } from "@/viz/analysis";

const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp", avif: "image/avif" };

export async function wholeImageUrl(path: string): Promise<string> {
  const url = await MediaService.URLFor(path);
  if (typeof URL.createObjectURL !== "function" || typeof fetch !== "function") return url;
  try {
    const bytes = await fetchAll(url);
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    return URL.createObjectURL(new Blob([bytes as BlobPart], { type: TYPES[ext] ?? "application/octet-stream" }));
  } catch {
    return url;
  }
}

/** Frees a URL from `wholeImageUrl` (no-op for other URLs). */
export function releaseImageUrl(url: string): void {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}
