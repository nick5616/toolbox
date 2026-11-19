/**
 * Shared timeline geometry (Phase 9 SPEC §14.3; Wave 0, frozen). The lanes
 * (WP-ES1), section bands (WP-ES1) and tracks (WP-ES2) line up through these:
 * every row has a header column of HEADER_PX, then x = (ms − scrollMs)·pps/1000.
 */
import { useEffect } from "react";
import { useEditStudio } from "@/editor/store";

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

/** Zoom range in pixels per second (Phase 21 SPEC §B2): 6 px/s fits long edits, 2000 px/s shows single frames at 60 fps. */
export const MIN_PPS = 6;
export const MAX_PPS = 2000;
/** One zoom key press (= / −) multiplies or divides the scale by this. */
export const ZOOM_STEP = 1.5;

export interface View {
  pps: number;
  scrollMs: number;
}

const clampNum = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** The widest view's scroll limit: the left edge never passes the last moment that still fills the window. */
export function maxScrollMs(durationMs: number, widthPx: number, pps: number): number {
  return Math.max(0, durationMs - (Math.max(1, widthPx) * 1000) / pps);
}

/**
 * Zooms by `factor` keeping the moment `anchorMs` at the same x on screen
 * (the playhead for the keys, the pointer for Ctrl+wheel and a pinch). Never
 * further out than the whole edit nor outside 6–2000 px/s.
 */
export function zoomAround(view: View, factor: number, anchorMs: number, widthPx: number, durationMs: number): View {
  const fit = fitPps(durationMs, widthPx);
  const pps = clampNum(view.pps * factor, Math.min(MAX_PPS, Math.max(MIN_PPS, Math.min(fit, view.pps))), MAX_PPS);
  const x = msToX(anchorMs, view.pps, view.scrollMs);
  return { pps, scrollMs: clampNum(anchorMs - (x * 1000) / pps, 0, maxScrollMs(durationMs, widthPx, pps)) };
}

/** The zoom slider's 0..1000 position of a scale (logarithmic: each step is the same factor). */
export function ppsToSlider(pps: number): number {
  return Math.round((Math.log(clampNum(pps, MIN_PPS, MAX_PPS) / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)) * 1000);
}

/** The scale at a zoom slider position. */
export function sliderToPps(v: number): number {
  return MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, clampNum(v, 0, 1000) / 1000);
}

/** The scale at which the whole edit fits the width (never below the minimum zoom). */
export function fitPps(durationMs: number, widthPx: number): number {
  return clampNum((Math.max(1, widthPx) * 1000) / Math.max(1, durationMs), MIN_PPS, MAX_PPS);
}

/** `\` : the whole edit in view, with a little room at the right. */
export function fitView(durationMs: number, widthPx: number): View {
  return { pps: fitPps(durationMs * 1.02, widthPx), scrollMs: 0 };
}

/** Pans by `deltaPx` of the time area, within the edit. */
export function panBy(view: View, deltaPx: number, widthPx: number, durationMs: number): View {
  return { pps: view.pps, scrollMs: clampNum(view.scrollMs + (deltaPx * 1000) / view.pps, 0, maxScrollMs(durationMs, widthPx, view.pps)) };
}

/**
 * Wheel handling for any timeline row container (attach to the element that
 * spans header + time area), as in Premiere:
 * - Ctrl+wheel (and a trackpad pinch, which arrives as Ctrl+wheel) zooms the
 *   time around the pointer;
 * - Shift+wheel and sideways trackpad scrolling pan along the time (as do the
 *   scrollbar and a middle-button drag);
 * - the plain wheel scrolls the rows up and down.
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
      const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const next = zoomAround({ pps, scrollMs }, Math.exp(-wheelPx(e, 300) * 0.0015), xToMs(x, pps, scrollMs), timeWidth, durationMs);
        setView(next.pps, next.scrollMs);
        return;
      }
      if (sideways || e.shiftKey) {
        e.preventDefault();
        const d = wheelPx(e, timeWidth, sideways ? e.deltaX : e.deltaY || e.deltaX);
        const next = panBy({ pps, scrollMs }, d, timeWidth, durationMs);
        setView(next.pps, next.scrollMs);
        return;
      }
      const rows = rowsScroller(el);
      if (!rows) return;
      e.preventDefault();
      rows.scrollTop += wheelPx(e, rows.clientHeight);
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
