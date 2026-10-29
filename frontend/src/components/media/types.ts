// Shared media kit types (SPEC.md §3.11). Final: UI-M implements the
// components against these; tools consume them.

/** The letterboxed rectangle of the picture inside the player, in CSS px relative to the player's box. */
export interface ContentRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A time range on the timeline (ms, timeline time). */
export interface Range {
  id: string;
  startMs: number;
  endMs: number;
  /** Optional label drawn on the range. */
  label?: string;
}

/** A point or span marker (subtitle cues, lyric lines, redaction tracks). */
export interface Marker {
  id: string;
  startMs: number;
  /** Omit for a point marker. */
  endMs?: number;
  label?: string;
  tone?: "neutral" | "accent" | "warn" | "muted";
}

/** A box in 0..1 coordinates of the picture. */
export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "face" | "plate" | "manual";
  enabled: boolean;
  label?: string;
}

/** Imperative handle of MediaPlayer. */
export interface MediaPlayerHandle {
  play(): void;
  pause(): void;
  toggle(): void;
  /** Seek to a timeline time (ms). */
  seek(ms: number): void;
  /** Step frames (negative = back). */
  step(frames: number): void;
  /** Current timeline time (ms). */
  currentMs(): number;
  playing(): boolean;
}
