export interface WaveformProps {
  /** Peaks 0..1. */
  peaks: number[];
  /** 0..1 portion already played (drawn in the accent colour). */
  progress?: number;
  /** Optional highlighted band, 0..1 of the width (e.g. the 10 s preview window). */
  band?: { start: number; end: number };
  onSeek?: (fraction: number) => void;
  height?: number;
  className?: string;
}

/** Canvas waveform (SPEC.md §3.11). UI-M implements it. */
export function Waveform(_props: WaveformProps) {
  return <div data-testid="waveform" />;
}
