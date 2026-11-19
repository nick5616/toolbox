/**
 * Timeline UI state (Phase 21 SPEC §B2): the active tool, the In/Out range,
 * the clipboard, a selected gap, the measured width of the time area and a
 * request to open a param in the inspector. The document stays in
 * `useEditStudio`; nothing here is saved. It resets when another edit opens.
 *
 * Snapping and the playhead live in `useEditStudio` (`snap`, `playheadMs`).
 */
import { useMemo } from "react";
import { create } from "zustand";
import { useEditStudio } from "@/editor/store";
import type { ClipboardData, Gap } from "./edit";

export type TimelineTool = "select" | "razor" | "ripple" | "roll" | "slip";

export const TOOL_ORDER: readonly TimelineTool[] = ["select", "razor", "ripple", "roll", "slip"];

export interface TimelineToolInfo {
  id: TimelineTool;
  label: string;
  key: string;
  icon: string;
  tip: string;
}

export const TOOLS: readonly TimelineToolInfo[] = [
  { id: "select", label: "Select", key: "V", icon: "mouse-pointer-2", tip: "Select, move and trim clips" },
  { id: "razor", label: "Razor", key: "C", icon: "scissors", tip: "Click a clip to cut it there (Shift+click cuts every track)" },
  { id: "ripple", label: "Ripple trim", key: "B", icon: "arrow-left-right", tip: "Drag a clip's edge: the clips after it move with it" },
  { id: "roll", label: "Roll", key: "N", icon: "move-horizontal", tip: "Drag the cut between two clips: both edges move together" },
  { id: "slip", label: "Slip", key: "Y", icon: "gallery-horizontal-end", tip: "Drag inside a clip to change which part of the file it shows" },
];

export interface SlipReadout {
  clipId: string;
  /** Source ms shown at the clip's first and last frame. */
  inMs: number;
  outMs: number;
}

export interface ParamFocusRequest {
  clipId: string;
  /** "transform.x", "effect:<id>.<param>", "speed", "gain"… (see keyframes.ts). */
  param: string;
  nonce: number;
}

export interface TimelineState {
  tool: TimelineTool;
  /** Timeline ms; both null = no range. */
  rangeInMs: number | null;
  rangeOutMs: number | null;
  /** Loop play inside the range (Shift+L). */
  loop: boolean;
  clipboard: ClipboardData | null;
  gap: Gap | null;
  /** Width of the time area in px (the header column excluded), as measured by the tracks. */
  viewWidthPx: number;
  /** While a slip drag runs: the in/out the inspector shows. */
  slip: SlipReadout | null;
  paramFocus: ParamFocusRequest | null;

  setTool(t: TimelineTool): void;
  setRange(inMs: number | null, outMs: number | null): void;
  clearRange(): void;
  setLoop(on: boolean): void;
  setClipboard(c: ClipboardData | null): void;
  selectGap(g: Gap | null): void;
  setViewWidth(px: number): void;
  setSlip(s: SlipReadout | null): void;
  focusParam(clipId: string, param: string): void;
}

const initial = {
  tool: "select" as TimelineTool,
  rangeInMs: null,
  rangeOutMs: null,
  loop: false,
  gap: null,
  slip: null,
  paramFocus: null,
};

let focusSeq = 0;

export const useTimelineStore = create<TimelineState>((set) => ({
  ...initial,
  clipboard: null,
  viewWidthPx: 0,
  setTool: (tool) => set({ tool, gap: null, slip: null }),
  setRange: (rangeInMs, rangeOutMs) => {
    if (rangeInMs !== null && rangeOutMs !== null && rangeOutMs <= rangeInMs) set({ rangeInMs: null, rangeOutMs: null, loop: false });
    else set({ rangeInMs, rangeOutMs, ...(rangeInMs === null || rangeOutMs === null ? { loop: false } : {}) });
  },
  clearRange: () => set({ rangeInMs: null, rangeOutMs: null, loop: false }),
  setLoop: (loop) => set({ loop }),
  setClipboard: (clipboard) => set({ clipboard }),
  selectGap: (gap) => set({ gap }),
  setViewWidth: (viewWidthPx) => set((s) => (s.viewWidthPx === viewWidthPx ? s : { viewWidthPx })),
  setSlip: (slip) => set({ slip }),
  focusParam: (clipId, param) => set({ paramFocus: { clipId, param, nonce: ++focusSeq } }),
}));

// A new edit starts clean (the clipboard survives: copying across edits is handy).
useEditStudio.subscribe((s, prev) => {
  if (s.projectId !== prev.projectId) useTimelineStore.setState({ ...initial });
});

export interface TimelineRange {
  inMs: number;
  outMs: number;
}

/** The In/Out range (timeline ms), or null when none is set. Export's "In–Out" reads this. */
export function useTimelineRange(): TimelineRange | null {
  const inMs = useTimelineStore((s) => s.rangeInMs);
  const outMs = useTimelineStore((s) => s.rangeOutMs);
  return useMemo(() => (inMs !== null && outMs !== null && outMs > inMs ? { inMs, outMs } : null), [inMs, outMs]);
}

/** The range right now (outside React). */
export function currentRange(): TimelineRange | null {
  const { rangeInMs, rangeOutMs } = useTimelineStore.getState();
  return rangeInMs !== null && rangeOutMs !== null && rangeOutMs > rangeInMs ? { inMs: rangeInMs, outMs: rangeOutMs } : null;
}

/** I: the range starts at the playhead (the end defaults to the end of the edit). */
export function markIn(playheadMs: number, endMs: number): void {
  const { rangeOutMs, setRange } = useTimelineStore.getState();
  const out = rangeOutMs !== null && rangeOutMs > playheadMs ? rangeOutMs : endMs;
  setRange(Math.round(playheadMs), out > playheadMs ? Math.round(out) : null);
}

/** O: the range ends at the playhead (the start defaults to 0). */
export function markOut(playheadMs: number): void {
  const { rangeInMs, setRange } = useTimelineStore.getState();
  const from = rangeInMs !== null && rangeInMs < playheadMs ? rangeInMs : 0;
  setRange(from < playheadMs ? from : null, Math.round(playheadMs));
}
