/**
 * Marker derivation (Phase 9 SPEC §5). WP-ES1 implements it; the signature is
 * frozen (Wave 0 stub returns beats only so the UI has something to draw).
 */
import type { EditMarkerState } from "@/lib/api";
import type { Analysis } from "../analysis";
import type { Marker, SongRange } from "./types";

/** Fixed tap latency subtracted from tapped markers (§5.6). */
export const TAP_LATENCY_MS = 40;

/**
 * Every lane's markers inside [range.startMs, range.endMs) (song ms), sorted by
 * (ms, lane), overrides applied; `ms` is timeline ms (songMs − range.startMs).
 */
export function deriveMarkers(a: Analysis, state: EditMarkerState, range: SongRange): Marker[] {
  void state;
  return a.audio.beats
    .filter((t) => t >= range.startMs && t < range.endMs)
    .map((t, i) => ({ id: `beat:${t}`, lane: "beat" as const, ms: t - range.startMs, strength: 1, beatIndex: i }));
}
