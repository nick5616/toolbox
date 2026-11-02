import { ComposerService, FilesService, MediaService, PostsService } from "@/lib/api";

// Lazy pictures and clip durations for source tiles. Nothing here runs until a
// tile has scrolled into view.

const MAX_THUMBS = 400;
const thumbs = new Map<string, Promise<string>>();

export function clearSourceCaches(): void {
  thumbs.clear();
  durations.clear();
  queue.length = 0;
}

async function resolveThumb(path: string, kind: string, maxDim: number): Promise<string> {
  if (kind === "clip") return MediaService.Frame(path, 0, maxDim);
  try {
    return await FilesService.ImageThumb(path, maxDim);
  } catch (e) {
    // HEIC (and anything the Go decoder doesn't read) goes through the engine.
    try {
      return await ComposerService.LoadImage(path, maxDim);
    } catch {
      throw e;
    }
  }
}

/** A picture URL for a source: a photo thumbnail or a clip's first frame. Cached. */
export function loadSourceThumb(path: string, kind: string, maxDim = 256): Promise<string> {
  const key = `${kind}|${path}|${maxDim}`;
  const hit = thumbs.get(key);
  if (hit) {
    thumbs.delete(key);
    thumbs.set(key, hit);
    return hit;
  }
  const p = resolveThumb(path, kind, maxDim);
  thumbs.set(key, p);
  p.catch(() => thumbs.delete(key));
  while (thumbs.size > MAX_THUMBS) {
    const oldest = thumbs.keys().next();
    if (oldest.done) break;
    thumbs.delete(oldest.value);
  }
  return p;
}

// ---- clip durations, probed in small batches ----

export const DURATION_BATCH = 6;
const durations = new Map<string, Promise<number>>();
const queue: { path: string; resolve: (ms: number) => void }[] = [];
let draining = false;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const batch = queue.splice(0, DURATION_BATCH);
      let infos: { path: string; durationMs: number }[] = [];
      try {
        infos = (await PostsService.SlideInfo(batch.map((b) => b.path))) ?? [];
      } catch {
        infos = [];
      }
      for (const b of batch) b.resolve(infos.find((i) => i.path === b.path)?.durationMs ?? 0);
    }
  } finally {
    draining = false;
  }
}

/** A clip's duration in ms (0 when unknown), probed lazily and in batches of DURATION_BATCH. */
export function loadClipDuration(path: string): Promise<number> {
  const hit = durations.get(path);
  if (hit) return hit;
  const p = new Promise<number>((resolve) => {
    queue.push({ path, resolve });
    // Let the tiles that became visible together join the same batch.
    setTimeout(() => void drain(), 20);
  });
  durations.set(path, p);
  return p;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
