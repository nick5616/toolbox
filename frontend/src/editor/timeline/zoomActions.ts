/**
 * Zoom actions for the keys (= − \), the toolbar slider and the buttons
 * (Phase 21 SPEC §B2). They read the open edit, the measured width and the
 * view, and write the view through `setView`.
 */
import { editLength } from "@/viz/edit/types";
import { fitView, zoomAround, ZOOM_STEP } from "@/editor/geometry";
import { useEditStudio } from "@/editor/store";
import { timelineRoomMs } from "./songFile";
import { useTimelineStore } from "./timelineStore";

const FALLBACK_WIDTH = 1000;

function context(): { width: number; room: number } | null {
  const doc = useEditStudio.getState().history?.present;
  if (!doc) return null;
  return { width: useTimelineStore.getState().viewWidthPx || FALLBACK_WIDTH, room: timelineRoomMs(doc) };
}

/** Zooms by `factor` around the playhead (the middle of the view when the playhead is off screen). */
export function zoomBy(factor: number): void {
  const c = context();
  if (!c) return;
  const st = useEditStudio.getState();
  const visibleMs = (c.width * 1000) / st.pps;
  const onScreen = st.playheadMs >= st.scrollMs && st.playheadMs <= st.scrollMs + visibleMs;
  const anchor = onScreen ? st.playheadMs : st.scrollMs + visibleMs / 2;
  const next = zoomAround({ pps: st.pps, scrollMs: st.scrollMs }, factor, anchor, c.width, c.room);
  st.setView(next.pps, next.scrollMs);
}

export const zoomIn = (): void => zoomBy(ZOOM_STEP);
export const zoomOut = (): void => zoomBy(1 / ZOOM_STEP);

/** Zooms to a scale (the slider). */
export function zoomToPps(pps: number): void {
  const st = useEditStudio.getState();
  if (pps > 0 && pps !== st.pps) zoomBy(pps / st.pps);
}

/** `\`: the whole edit in view. */
export function zoomFit(): void {
  const c = context();
  if (!c) return;
  const doc = useEditStudio.getState().history?.present;
  let length = doc ? editLength(doc) : 0;
  for (const t of doc?.tracks ?? []) for (const clip of t.clips) length = Math.max(length, clip.endMs);
  const v = fitView(Math.max(length, 1000), c.width);
  useEditStudio.getState().setView(v.pps, v.scrollMs);
}
