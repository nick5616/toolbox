/**
 * Waveform peaks (Phase 21 SPEC §B1/§B2): `SourceState.peaks` (peaks.bin) is
 * fetched once through the media URL, parsed and cached; E3 draws them.
 */
import { useEffect, useState } from "react";
import { useEditStudio } from "@/editor/store";
import { wholeFileBytes } from "@/lib/wholeFile";
import type { Peaks, PeaksHeader } from "./types";

/** Parses peaks.bin: a JSON header line, then min/max int8 pairs. */
export function parsePeaks(bytes: Uint8Array): Peaks | null {
  const nl = bytes.indexOf(10);
  if (nl < 0) return null;
  let header: PeaksHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(0, nl))) as PeaksHeader;
  } catch {
    return null;
  }
  if (header.v !== 1 || !(header.rate > 0)) return null;
  const body = bytes.subarray(nl + 1);
  const n = Math.floor(body.length / 2);
  const min = new Int8Array(n);
  const max = new Int8Array(n);
  const view = new Int8Array(body.buffer, body.byteOffset, n * 2);
  for (let i = 0; i < n; i++) {
    min[i] = view[2 * i] ?? 0;
    max[i] = view[2 * i + 1] ?? 0;
  }
  return { rate: header.rate, channels: header.channels, min, max, durationMs: (n / header.rate) * 1000 };
}

const cache = new Map<string, Peaks | null>();
const inflight = new Map<string, Promise<Peaks | null>>();

/** Loads and parses a peaks.bin once (null when unreadable); later calls share the result. */
export function loadPeaks(file: string, read: (f: string) => Promise<Uint8Array> = wholeFileBytes): Promise<Peaks | null> {
  if (cache.has(file)) return Promise.resolve(cache.get(file) ?? null);
  let p = inflight.get(file);
  if (!p) {
    p = read(file)
      .then((b) => parsePeaks(b))
      .catch(() => null)
      .then((r) => {
        cache.set(file, r);
        inflight.delete(file);
        return r;
      });
    inflight.set(file, p);
  }
  return p;
}

/** Forgets loaded peaks (tests; a re-prepared source gets a new file name anyway). */
export function clearPeaksCache(): void {
  cache.clear();
  inflight.clear();
}

/** The peaks of a source file, or null while not loaded / the source has none. */
export function usePeaks(path: string | null): Peaks | null {
  const file = useEditStudio((s) => (path ? (s.sources[path]?.peaks ?? "") : ""));
  const [loaded, setLoaded] = useState<{ file: string; peaks: Peaks | null } | null>(null);
  useEffect(() => {
    if (!file) return;
    let live = true;
    void loadPeaks(file).then((peaks) => live && setLoaded({ file, peaks }));
    return () => {
      live = false;
    };
  }, [file]);
  if (!file) return null;
  if (cache.has(file)) return cache.get(file) ?? null;
  return loaded && loaded.file === file ? loaded.peaks : null;
}
