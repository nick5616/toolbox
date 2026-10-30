/**
 * The quick visuals picker for Lyric Video and Subtitles (SPEC.md §9.1).
 * CONTRACT (foundation): VP1 implements it.
 */
import type { TimedLine, VisualsSpec } from "@/lib/api";

export interface VisualsPickerProps {
  inputPath: string;
  /** The tool's timed text (lyrics or cues), for word reactions and mood. */
  lines: TimedLine[] | null;
  value: VisualsSpec | null;
  onChange(v: VisualsSpec): void;
  /** overlay = over a video (background layers dropped). */
  mode: "background" | "overlay";
  /** The tool's output aspect (width / height). */
  aspect: number;
  /** The tool's player position, if it has one. */
  playheadMs?: number;
  /** "Open the full designer" (the host switches to its embedded designer). */
  onOpenDesigner?(): void;
  className?: string;
}

export function VisualsPicker(_props: VisualsPickerProps) {
  return null; // VP1
}
