/**
 * A live WebGL canvas rendering a show at a time (SPEC.md §9.1): the preview
 * in the designer and the background of the Lyric Video and Subtitles
 * previews. It letterboxes to `aspect` inside its box and renders on each
 * `timeMs` change (callers drive time from their player). CONTRACT
 * (foundation): VP1 implements it.
 */
import type { Analysis } from "@/viz/analysis";
import type { Show } from "@/viz/types";

export interface VisualsCanvasProps {
  show: Show | null;
  analysis: Analysis | null;
  timeMs: number;
  /** Output width / height. */
  aspect: number;
  mode: "opaque" | "overlay";
  /** "auto" drops to draft below 45 fps for 2 s (SPEC.md §6.1). */
  quality?: "auto" | "full" | "draft";
  /** Optional textures (cover art, a background image). */
  cover?: string | null; // /media URL
  image?: string | null;
  /** Reports the measured fps about once a second. */
  onFps?(fps: number): void;
  className?: string;
}

export function VisualsCanvas(_props: VisualsCanvasProps) {
  return null; // VP1
}
