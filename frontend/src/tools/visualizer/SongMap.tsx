/**
 * The Song Map (SPEC.md §8.2): sections, beats/bars, instrument lanes,
 * chords, mood and lyrics on one zoomable time axis with a playhead.
 * CONTRACT (foundation): UI-V1 implements it; UI-V2 embeds it in the designer
 * (seeking, the selection for Export, and editable sections for the Timeline tab).
 */
import type { Analysis } from "@/viz/analysis";
import type { TimelineEntry } from "@/viz/types";

export type SongMapLane = "sections" | "beats" | "drums" | "bass" | "vocals" | "other" | "chords" | "mood" | "lyrics";

export interface SongMapProps {
  analysis: Analysis;
  /** The scenes in effect, drawn on the sections lane when given. */
  timeline?: TimelineEntry[] | null;
  playheadMs: number;
  onSeek(ms: number): void;
  /** Shift-drag selection (Export range). */
  selection?: { startMs: number; endMs: number } | null;
  onSelect?(range: { startMs: number; endMs: number } | null): void;
  /** Clicking a section block (Timeline tab). */
  onSectionClick?(index: number): void;
  /** Which lanes to show (default: all that have data). */
  lanes?: SongMapLane[];
  className?: string;
}

export function SongMap(_props: SongMapProps) {
  return null; // UI-V1
}
