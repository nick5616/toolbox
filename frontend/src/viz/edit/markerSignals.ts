/**
 * Marker signals `marker.<lane>` (Phase 9 SPEC §5.5). WP-ES1 implements it;
 * the class shape is frozen (the Wave 0 stub returns 0).
 */
import type { Analysis } from "../analysis";
import type { SectionLabel } from "../types";
import type { Marker, MarkerLane } from "./types";

export interface MarkerFilter {
  every?: number; // 1..16
  sections?: SectionLabel[];
}

export class MarkerSignals {
  /**
   * @param markers deriveMarkers(...) output (timeline ms)
   * @param songStartMs the range start, so song ms = timeline ms + songStartMs
   */
  constructor(
    readonly analysis: Analysis,
    readonly markers: readonly Marker[],
    readonly songStartMs: number,
  ) {}

  /** The lane's pulse envelope at song ms (0..1), attack/release as Signals.envelope. */
  value(lane: MarkerLane, filter: MarkerFilter, songMs: number, attackMs?: number, releaseMs?: number): number {
    void lane;
    void filter;
    void songMs;
    void attackMs;
    void releaseMs;
    return 0;
  }
}
