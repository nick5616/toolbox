/**
 * Shared timeline geometry (Phase 9 SPEC §14.3; Wave 0, frozen). The lanes
 * (WP-ES1), section bands (WP-ES1) and tracks (WP-ES2) line up through these:
 * every row has a header column of HEADER_PX, then x = (ms − scrollMs)·pps/1000.
 */
import { useEffect } from "react";
import { useEditStudio } from "./store";

/** Width of the row headers (lane names, track headers). */
export const HEADER_PX = 168;
/** Height of the ruler at the top of the lanes. */
export const RULER_PX = 22;
/** Pixels of a marker lane row. */
export const LANE_ROW_PX = 18;
/** Snap threshold in pixels. */
export const SNAP_PX = 8;

/** x (px, from the left edge of the time area, after the header) of timeline ms. */
export function msToX(ms: number, pps: number, scrollMs: number): number {
  return ((ms - scrollMs) * pps) / 1000;
}

/** Timeline ms at x (px, from the left edge of the time area). */
export function xToMs(x: number, pps: number, scrollMs: number): number {
  return scrollMs + (x * 1000) / pps;
}

/** The visible window [startMs, endMs) for a time-area width. */
export function visibleRange(widthPx: number, pps: number, scrollMs: number): { startMs: number; endMs: number } {
  return { startMs: scrollMs, endMs: scrollMs + (Math.max(0, widthPx) * 1000) / pps };
}

/**
 * Wheel handling for any timeline row container (attach to the element that
 * spans header + time area): Ctrl/Cmd+wheel zooms around the pointer;
 * Shift+wheel and sideways (trackpad) scrolling move along the time; a plain
 * wheel scrolls the rows when they overflow (lanes or tracks that don't fit)
 * and otherwise moves along the time. Clamped to [0, durationMs].
 */
export function useTimelineWheel(el: HTMLElement | null, durationMs: number): void {
  useEffect(() => {
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const { pps, scrollMs, setView } = useEditStudio.getState();
      const rect = el.getBoundingClientRect();
      const x = Math.max(0, e.clientX - rect.left - HEADER_PX);
      const timeWidth = Math.max(1, rect.width - HEADER_PX);
      const maxScroll = Math.max(0, durationMs - (timeWidth * 1000) / pps);
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const at = xToMs(x, pps, scrollMs);
        const next = Math.max(6, Math.min(800, pps * Math.exp(-e.deltaY * 0.0015)));
        const nextMax = Math.max(0, durationMs - (timeWidth * 1000) / next);
        setView(next, Math.min(nextMax, Math.max(0, at - (x * 1000) / next)));
        return;
      }
      const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (!sideways && !e.shiftKey && rowsScroll(e.target, el)) return; // the browser scrolls the rows
      e.preventDefault();
      const d = sideways ? e.deltaX : e.deltaY;
      setView(pps, Math.min(maxScroll, Math.max(0, scrollMs + (d * 1000) / pps)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [el, durationMs]);
}

/** Whether a vertically scrollable box with more rows than fit sits between the wheel's target and the timeline root. */
function rowsScroll(target: EventTarget | null, root: HTMLElement): boolean {
  for (let n = target instanceof Element ? target : null; n && n !== root.parentElement; n = n.parentElement) {
    if (n instanceof HTMLElement && n.scrollHeight > n.clientHeight + 1) {
      const oy = getComputedStyle(n).overflowY;
      if (oy === "auto" || oy === "scroll") return true;
    }
    if (n === root) break;
  }
  return false;
}
