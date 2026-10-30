/**
 * Pure parts of the Song Map: which lanes exist for an analysis, their sizes,
 * and the time <-> pixel maths. No DOM here, so it is table-testable.
 */
import type { Analysis } from "@/viz/analysis";
import type { TimelineEntry } from "@/viz/types";

export type SongMapLaneId = "sections" | "beats" | "drums" | "bass" | "vocals" | "other" | "chords" | "mood" | "lyrics";

/** Lanes, top to bottom (SPEC.md §8.2). */
export const LANE_ORDER: readonly SongMapLaneId[] = ["sections", "beats", "drums", "bass", "vocals", "other", "chords", "mood", "lyrics"];

export const LANE_LABEL: Record<SongMapLaneId, string> = {
  sections: "Sections",
  beats: "Beats",
  drums: "Drums",
  bass: "Bass",
  vocals: "Vocals",
  other: "Other",
  chords: "Chords",
  mood: "Mood",
  lyrics: "Lyrics",
};

export const LANE_HEIGHT: Record<SongMapLaneId, number> = {
  sections: 28,
  beats: 18,
  drums: 36,
  bass: 26,
  vocals: 40,
  other: 26,
  chords: 24,
  mood: 20,
  lyrics: 36,
};

export const RULER_HEIGHT = 16;
export const LABEL_WIDTH = 76;
export const MAX_PX_PER_SEC = 400;

/** True when the analysis has something to draw on the lane. */
export function laneHasData(a: Analysis, lane: SongMapLaneId, timeline?: readonly TimelineEntry[] | null): boolean {
  switch (lane) {
    case "sections":
      return a.audio.sections.length > 0 || (timeline?.length ?? 0) > 0;
    case "beats":
      return a.audio.beats.length > 0;
    case "drums":
      return a.has("drums.level");
    case "bass":
      return a.has("bass.level");
    case "vocals":
      return a.has("vocals.level");
    case "other":
      return a.has("other.level");
    case "chords":
      return a.audio.chords.length > 0;
    case "mood":
      return (a.text?.mood.length ?? 0) > 0;
    case "lyrics":
      return (a.text?.lines.length ?? 0) > 0;
  }
}

/** The lanes to draw: the requested ones (default all) that have data, in canonical order. */
export function visibleLanes(a: Analysis, requested?: readonly SongMapLaneId[], timeline?: readonly TimelineEntry[] | null): SongMapLaneId[] {
  const want = requested ? new Set(requested) : null;
  return LANE_ORDER.filter((l) => (!want || want.has(l)) && laneHasData(a, l, timeline));
}

/** The view of the time axis: which window of the song the canvases show. */
export interface View {
  startMs: number;
  endMs: number;
  /** CSS pixels of the visible width. */
  width: number;
}

export function pxPerSecFit(viewWidth: number, durationMs: number): number {
  return viewWidth / Math.max(1, durationMs / 1000);
}

export function clampPxPerSec(px: number, viewWidth: number, durationMs: number): number {
  const fit = pxPerSecFit(viewWidth, durationMs);
  return Math.max(fit, Math.min(Math.max(fit, MAX_PX_PER_SEC), px));
}

export function contentWidth(pxPerSec: number, durationMs: number): number {
  return Math.max(1, Math.round((durationMs / 1000) * pxPerSec));
}

export function viewFor(scrollLeft: number, viewWidth: number, pxPerSec: number, durationMs: number): View {
  const startMs = (scrollLeft / pxPerSec) * 1000;
  return { startMs, endMs: Math.min(durationMs, startMs + (viewWidth / pxPerSec) * 1000), width: viewWidth };
}

/** Time at a pixel x (relative to the left edge of the visible window). */
export function timeAtX(x: number, scrollLeft: number, pxPerSec: number, durationMs: number): number {
  return Math.max(0, Math.min(durationMs, ((scrollLeft + x) / pxPerSec) * 1000));
}

/** Pixel x (relative to the visible window) of a time. */
export function xAtTime(ms: number, scrollLeft: number, pxPerSec: number): number {
  return (ms / 1000) * pxPerSec - scrollLeft;
}

/** Scroll position that keeps the time `ms` under the pixel `x` after a zoom. */
export function scrollForAnchor(ms: number, x: number, pxPerSec: number, viewWidth: number, durationMs: number): number {
  const max = Math.max(0, contentWidth(pxPerSec, durationMs) - viewWidth);
  return Math.max(0, Math.min(max, (ms / 1000) * pxPerSec - x));
}

/** Normalises a drag into a range, or null when it is too short to mean anything. */
export function selectionFromDrag(aMs: number, bMs: number, minMs = 100): { startMs: number; endMs: number } | null {
  const startMs = Math.min(aMs, bMs);
  const endMs = Math.max(aMs, bMs);
  return endMs - startMs < minMs ? null : { startMs: Math.round(startMs), endMs: Math.round(endMs) };
}

/** The index of the block (sections lane) under a time, or -1. */
export function blockIndexAt(blocks: ReadonlyArray<{ startMs: number; endMs: number }>, ms: number): number {
  return blocks.findIndex((b) => ms >= b.startMs && ms < b.endMs);
}

/** The blocks drawn on the sections lane: the timeline's scenes when given, else the analysis sections. */
export interface SectionBlock {
  startMs: number;
  endMs: number;
  label: string;
  group: string;
}

export function sectionBlocks(a: Analysis, timeline?: readonly TimelineEntry[] | null): SectionBlock[] {
  if (timeline && timeline.length > 0) {
    return timeline.map((t) => {
      const s = a.sectionAt(t.startMs)?.section;
      return { startMs: t.startMs, endMs: t.endMs, label: t.sceneId, group: s?.group ?? t.sceneId };
    });
  }
  return a.audio.sections.map((s) => ({ startMs: s.startMs, endMs: s.endMs, label: s.label, group: s.group }));
}

/** A stable hue for a section group so repeats share a colour. */
export function groupHue(group: string): number {
  let h = 0;
  for (let i = 0; i < group.length; i++) h = (h * 31 + group.charCodeAt(i)) >>> 0;
  return (h * 47) % 360;
}

export const MOTIF_GLYPH: Record<string, string> = {
  fire: "\u{1F525}",
  rain: "\u{1F327}",
  snow: "❄",
  stars: "⭐",
  ocean: "\u{1F30A}",
  flowers: "\u{1F338}",
  hearts: "❤",
  city: "\u{1F3D9}",
  sun: "☀",
  night: "\u{1F319}",
  storm: "⛈",
  smoke: "\u{1F32B}",
};

/** "m:ss" for the ruler. */
export function rulerLabel(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A tick spacing (seconds) giving at least `minPx` between labelled ticks. */
export function rulerStepSec(pxPerSec: number, minPx = 64): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 3600];
  return steps.find((s) => s * pxPerSec >= minPx) ?? 3600;
}
