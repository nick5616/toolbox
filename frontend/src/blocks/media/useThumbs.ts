// Cached thumbnails and waveforms for the timeline lanes.
import { useEffect, useState } from "react";
import { FilesService, MediaService } from "@/lib/api";

export const FILMSTRIP_FRAMES = 10;
export const FILMSTRIP_HEIGHT = 48;

const thumbCache = new Map<string, Promise<string>>();
const waveCache = new Map<string, Promise<number[]>>();

function cached<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
  let p = cache.get(key);
  if (!p) {
    p = make();
    cache.set(key, p);
    // A failure shouldn't stick: the next mount retries.
    p.catch(() => cache.delete(key));
  }
  return p;
}

/** A video's filmstrip sprite URL or a photo's small thumbnail (data URL); "" until ready or on failure. */
export function useThumb(path: string, kind: string): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let cancelled = false;
    const p =
      kind === "image"
        ? cached(thumbCache, `i:${path}`, () => FilesService.ImageThumb(path, 160))
        : cached(thumbCache, `v:${path}`, () => MediaService.Filmstrip(path, FILMSTRIP_FRAMES, FILMSTRIP_HEIGHT));
    p.then(
      (u) => !cancelled && setUrl(u),
      () => !cancelled && setUrl(""),
    );
    return () => {
      cancelled = true;
    };
  }, [path, kind]);
  return url;
}

/** Peaks 0..1 of an audio file (empty until ready). */
export function useWaveform(path: string | null, buckets = 600): number[] {
  const [peaks, setPeaks] = useState<number[]>([]);
  useEffect(() => {
    if (!path) {
      setPeaks([]);
      return;
    }
    let cancelled = false;
    cached(waveCache, `${path}:${buckets}`, async () => (await MediaService.Waveform(path, buckets)) ?? []).then(
      (p) => !cancelled && setPeaks(p),
      () => !cancelled && setPeaks([]),
    );
    return () => {
      cancelled = true;
    };
  }, [path, buckets]);
  return peaks;
}
