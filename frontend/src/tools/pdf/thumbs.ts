import { PdfService } from "@/lib/api";

const MAX_CONCURRENT = 4;
const MAX_CACHED = 400;

let active = 0;
const queue: Array<() => void> = [];
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function pump() {
  while (active < MAX_CONCURRENT) {
    const next = queue.shift();
    if (!next) return;
    active++;
    next();
  }
}

/**
 * Renders a PDF page thumbnail through PdfService.Thumbnail, at most 4 calls at
 * once app-wide. Results are cached per file/page/width (never per password).
 */
export function loadPdfThumb(path: string, page: number, width: number, password: string): Promise<string> {
  const key = `${path}|${page}|${width}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = new Promise<string>((resolve, reject) => {
    queue.push(() => {
      PdfService.Thumbnail(path, page, width, password)
        .then((url) => {
          if (cache.size >= MAX_CACHED) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
          cache.set(key, url);
          resolve(url);
        }, reject)
        .finally(() => {
          active--;
          inflight.delete(key);
          pump();
        });
    });
    pump();
  });
  inflight.set(key, p);
  return p;
}

export function clearPdfThumbCache(): void {
  cache.clear();
}
