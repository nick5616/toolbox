/** The signals the Inspector's meters read: the visualizer's Signals plus marker signals for the open edit. */
import { useMemo } from "react";
import type { Analysis } from "@/viz/analysis";
import { MarkerSignals } from "@/viz/edit/markerSignals";
import { isMarkerSignal } from "@/viz/edit/schema";
import type { EditMod, MarkerLane } from "@/viz/edit/types";
import { DEFAULT_ATTACK_MS, DEFAULT_RELEASE_MS, Signals } from "@/viz/signals";
import type { SignalId } from "@/viz/types";
import { useEditStudio, useMarkers } from "@/editor/store";

export interface EditSignalSources {
  analysis: Analysis;
  signals: Signals;
  markers: MarkerSignals;
  songStartMs: number;
}

/** Null until the song's analysis is loaded. */
export function useEditSignals(): EditSignalSources | null {
  const analysis = useEditStudio((s) => s.analysis);
  const songStartMs = useEditStudio((s) => s.history?.present.song?.startMs ?? 0);
  const markers = useMarkers();
  return useMemo(() => (analysis ? { analysis, signals: new Signals(analysis), markers: new MarkerSignals(analysis, markers, songStartMs), songStartMs } : null), [analysis, markers, songStartMs]);
}

/** The playhead (timeline ms), re-rendering a component every 100 ms at most. */
export function useLivePlayheadMs(): number {
  const bucket = useEditStudio((s) => Math.floor(s.playheadMs / 100));
  return bucket * 100;
}

/** A reaction's driver at a timeline time, 0..1, with its section gate (what the meter shows). */
export function modLevel(src: EditSignalSources, mod: EditMod, timelineMs: number): number {
  const songMs = src.songStartMs + timelineMs;
  if (mod.sections?.length) {
    const label = src.analysis.sectionAt(songMs)?.section.label;
    if (!label || !mod.sections.includes(label)) return 0;
  }
  const attack = mod.attackMs ?? DEFAULT_ATTACK_MS;
  const release = mod.releaseMs ?? DEFAULT_RELEASE_MS;
  const v = isMarkerSignal(mod.signal)
    ? src.markers.value(mod.signal.slice("marker.".length) as MarkerLane, { every: mod.every, sections: mod.sections }, songMs, attack, release)
    : src.signals.value(mod.signal as SignalId, songMs, attack, release);
  return Math.max(0, Math.min(1, v));
}
