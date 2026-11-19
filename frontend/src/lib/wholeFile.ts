/**
 * The whole of a local file as bytes (or a blob: URL). Media URLs answer at
 * most 4 MiB per response (CLAUDE.md, Phase 6), so big files are read in
 * ranges and joined (`fetchAll`). `wholeImage.ts` is the same idea for an
 * <img>; the editor's audio decoder (`editor/audio`) uses `wholeFileBuffer`.
 */
import { MediaService } from "@/lib/api";
import { fetchAll } from "@/viz/analysis";

/** Reads a /media URL in ranges of at most 4 MiB and joins them. */
export function fetchWhole(url: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  return fetchAll(url, fetchImpl);
}

/** Gets the media URL for a path through MediaService, then reads all of it. */
export async function wholeFileBytes(path: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  const url = await MediaService.URLFor(path);
  return fetchAll(url, fetchImpl);
}

/** The bytes as an ArrayBuffer of exactly their length (what decodeAudioData takes). */
export async function wholeFileBuffer(path: string, fetchImpl: typeof fetch = fetch): Promise<ArrayBuffer> {
  const bytes = await wholeFileBytes(path, fetchImpl);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** A blob: URL with the whole file (free it with `releaseWholeFileUrl`). Falls back to the media URL. */
export async function wholeFileUrl(path: string, mime = "application/octet-stream"): Promise<string> {
  const url = await MediaService.URLFor(path);
  if (typeof URL.createObjectURL !== "function" || typeof fetch !== "function") return url;
  try {
    return URL.createObjectURL(new Blob([(await fetchAll(url)) as BlobPart], { type: mime }));
  } catch {
    return url;
  }
}

export function releaseWholeFileUrl(url: string): void {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}
