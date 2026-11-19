import { FilesService, MediaService, PdfService } from "@/lib/api";
import { LRU, Limiter, MAX_CONCURRENT, SharedLoader, useInView } from "@/lib/thumbs";
import { previewKind, type LibItem } from "../items";

/** What a card shows for one file, whatever its type. */
export type PreviewData =
  | { kind: "image"; src: string }
  | { kind: "video"; sprite: string }
  | { kind: "audio"; peaks: number[] }
  | { kind: "pdf"; src: string; pages: number }
  | { kind: "text"; text: string };

// The queue, LRU and "on screen" hook live in lib/thumbs (shared with every thumbnail grid).
export { LRU, Limiter, MAX_CONCURRENT, useInView };
export const CACHE_SIZE = 500;
export const THUMB_PX = 320;
export const FILMSTRIP_FRAMES = 8;
export const WAVE_BUCKETS = 100;

const loader = new SharedLoader<PreviewData>(CACHE_SIZE);

/** Cache key: path plus when the file changed (mtime, or the output's createdAt). */
export function previewKey(i: Pick<LibItem, "path" | "at" | "sizeBytes" | "hit">): string {
  // A search hit with a position (a video moment, a PDF page) shows that moment, so it has its own entry.
  return `${i.path}|${i.at}|${i.sizeBytes}${i.hit && i.hit.pos >= 0 ? `|@${i.hit.pos}` : ""}`;
}

export function clearPreviewCache(): void {
  loader.clear();
}

export function cachedPreview(i: LibItem): PreviewData | undefined {
  return loader.peek(previewKey(i));
}

async function fetchPreview(i: LibItem): Promise<PreviewData> {
  const pos = i.hit?.pos ?? -1;
  switch (previewKind(i)) {
    case "image":
      return { kind: "image", src: await FilesService.ImageThumb(i.path, THUMB_PX) };
    case "video":
      // A moment: that frame (`pos` is ms), not the poster sprite.
      if (pos >= 0) return { kind: "image", src: await MediaService.Frame(i.path, pos, THUMB_PX) };
      // One sprite of 8 frames serves the poster (an early frame) and the hover scrub.
      return { kind: "video", sprite: await MediaService.Filmstrip(i.path, FILMSTRIP_FRAMES, 120) };
    case "audio":
      return { kind: "audio", peaks: (await MediaService.Waveform(i.path, WAVE_BUCKETS)) ?? [] };
    case "pdf": {
      const [src, info] = await Promise.all([PdfService.Thumbnail(i.path, pos >= 0 ? pos + 1 : 1, 240, ""), PdfService.Info(i.path, "").catch(() => null)]);
      return { kind: "pdf", src, pages: info?.pages ?? 0 };
    }
    case "text":
      return { kind: "text", text: await FilesService.ReadText(i.path, 2048) };
    default:
      throw new Error("no preview");
  }
}

/** Loads a preview through the shared queue (≤ 6 at once) and the cache. `cancelled` drops a not-yet-started load. */
export function loadPreview(i: LibItem, cancelled: () => boolean = () => false): Promise<PreviewData | undefined> {
  return loader.load(previewKey(i), () => fetchPreview(i), cancelled);
}
