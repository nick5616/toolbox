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
 * spans header + time area):
 * - over the time area, the wheel moves along the time (sideways trackpad
 *   scrolling too);
 * - over the row headers, or with Shift, it scrolls the rows up and down;
 * - Ctrl/Cmd+wheel zooms around the pointer.
 * Clamped to [0, durationMs].
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
      const overHeaders = e.clientX - rect.left < HEADER_PX;
      if (!sideways && (e.shiftKey || overHeaders)) {
        const rows = rowsScroller(el);
        if (!rows) return;
        e.preventDefault();
        rows.scrollTop += wheelPx(e, rows.clientHeight);
        return;
      }
      e.preventDefault();
      const d = wheelPx(e, timeWidth, sideways ? e.deltaX : e.deltaY);
      setView(pps, Math.min(maxScroll, Math.max(0, scrollMs + (d * 1000) / pps)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [el, durationMs]);
}

/**
 * Middle-button drag (the wheel pressed) pans a timeline: sideways along the
 * time, up and down through the rows. Also stops the browser's autoscroll.
 */
export function useTimelinePan(el: HTMLElement | null, durationMs: number): void {
  useEffect(() => {
    if (!el) return;
    let drag: { id: number; x: number; y: number; scrollMs: number; top: number; rows: HTMLElement | null } | null = null;
    const down = (e: PointerEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      const st = useEditStudio.getState();
      const rows = rowsScroller(el);
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, scrollMs: st.scrollMs, top: rows?.scrollTop ?? 0, rows };
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
    };
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const { pps, setView } = useEditStudio.getState();
      const timeWidth = Math.max(1, el.getBoundingClientRect().width - HEADER_PX);
      const maxScroll = Math.max(0, durationMs - (timeWidth * 1000) / pps);
      setView(pps, Math.min(maxScroll, Math.max(0, drag.scrollMs - ((e.clientX - drag.x) * 1000) / pps)));
      if (drag.rows) drag.rows.scrollTop = drag.top - (e.clientY - drag.y);
    };
    const up = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      el.style.cursor = "";
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    // Windows starts autoscroll on the middle button's mousedown; middle clicks shouldn't paste/open either.
    const noAuto = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("mousedown", noAuto);
    el.addEventListener("auxclick", noAuto);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("mousedown", noAuto);
      el.removeEventListener("auxclick", noAuto);
    };
  }, [el, durationMs]);
}

/** Wheel delta in pixels (line and page modes converted). */
function wheelPx(e: WheelEvent, page: number, delta = e.deltaY): number {
  if (e.deltaMode === 1) return delta * 16;
  if (e.deltaMode === 2) return delta * page;
  return delta;
}

/** The element itself or its first descendant that scrolls vertically (the rows). */
export function rowsScroller(el: HTMLElement): HTMLElement | null {
  const ok = (n: HTMLElement) => /auto|scroll/.test(getComputedStyle(n).overflowY);
  if (ok(el)) return el;
  for (const n of el.querySelectorAll<HTMLElement>("*")) if (ok(n)) return n;
  return null;
}
