import type { Marker, Range } from "./types";

export interface TimelineProps {
  durationMs: number;
  playheadMs: number;
  onSeek: (ms: number) => void;
  /** A horizontal sprite from MediaService.Filmstrip. */
  filmstripUrl?: string;
  /** Peaks 0..1 from MediaService.Waveform. */
  waveform?: number[];
  ranges?: Range[];
  onRangesChange?: (ranges: Range[]) => void;
  selectedRange?: string;
  onSelectRange?: (id: string) => void;
  /** Keyframe times (ms), drawn as ticks when zoomed in. */
  keyframes?: number[];
  markers?: Marker[];
  onMarkerClick?: (id: string) => void;
  /** Frame duration for keyboard nudges (ms); default 1000/30. */
  frameMs?: number;
  zoomable?: boolean;
  className?: string;
}

/** Filmstrip/waveform track with ranges, markers and a playhead (SPEC.md §3.11). UI-M implements it. */
export function Timeline(_props: TimelineProps) {
  return <div data-testid="timeline" />;
}
