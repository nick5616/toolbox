/**
 * The motion metric's output (Phase 21 SPEC §C4): VizLab's motion mode writes
 * one `motion.json` with an entry per preset. FROZEN after Wave 0. V2 makes
 * it; V3 tunes against it; Color Grader's flash test (E3.4) reuses
 * `measureMotion` on its own frames.
 */
export interface MotionStats {
  /** WCAG 2.3.1 general flashes: the most in any 1 s window (frame mean and worst 4 × 4 cell). */
  flashMaxPerSec: number;
  /** Mean per-pixel |ΔL| between consecutive frames, 0..1 (64 × 36 downsample). */
  meanDelta: number;
  p95Delta: number;
  /** Frames whose correlation with the previous frame is < 0.5, outside a scene transition. */
  teleports: number;
  /** Mean |Δ dominant hue|, degrees per second. */
  hueChurn: number;
  /** Mean block-SAD motion proxy, 0..1. */
  busyness: number;
}

export interface MotionEntry extends MotionStats {
  preset: string;
  /** "fixture" or the analysis key. */
  source: string;
  /** show.reactivity used (Calm 0.5 / Balanced 1 / Wild 1.5). */
  intensity: number;
  frames: number;
  fps: number;
}

export interface MotionReport {
  version: 1;
  /** The git commit the numbers belong to ("before" runs: the Wave 0 commit). */
  commit: string;
  entries: MotionEntry[];
}

/** A downsampled frame for the metric: luma and hue per pixel (64 × 36). */
export interface MotionFrame {
  w: number;
  h: number;
  /** Relative luminance 0..1 (sRGB → linear, WCAG). */
  lum: Float32Array;
  /** Hue 0..360 (NaN where saturation < 0.15). */
  hue: Float32Array;
  /** True for frames inside a director transition window. */
  inTransition: boolean;
}
