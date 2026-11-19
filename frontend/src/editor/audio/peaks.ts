/**
 * Waveform peaks (Phase 21 SPEC §B1/§B2). Wave 0 stub: E2 implements the
 * loader (SourceState.peaks → fetched through the media URL, parsed,
 * cached); E3 draws them.
 */
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

/** The peaks of a source file, or null while not loaded / none. Wave 0: always null. */
export function usePeaks(_path: string | null): Peaks | null {
  return null;
}
