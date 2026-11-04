/**
 * Canvas drawing for the lanes (SPEC §14.4). Each function paints one row for
 * the visible window only; nothing here runs per playhead tick.
 */
import type { Marker, MarkerLane } from "@/viz/edit/types";
import { msToX } from "@/editor/geometry";
import { isRanged, RANGED_LANES, visibleMarkers } from "./laneLogic";

const FONT = '10px "Geist Variable", system-ui, sans-serif';

/** Sizes a canvas to CSS pixels × devicePixelRatio and returns its context scaled to CSS pixels (null without 2D support). */
export function prepCanvas(cv: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  if (cv.width !== pw) cv.width = pw;
  if (cv.height !== ph) cv.height = ph;
  let c: CanvasRenderingContext2D | null = null;
  try {
    c = cv.getContext("2d");
  } catch {
    c = null;
  }
  if (!c) return null;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  return c;
}

/** A theme colour (CSS variable) read at draw time. */
export function cssColor(el: Element, name: string, fallback: string): string {
  if (typeof getComputedStyle !== "function") return fallback;
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

export function laneColor(el: Element, lane: MarkerLane): string {
  return cssColor(el, `--lane-${lane}`, "#8b93a7");
}

export interface MarkerDrawOptions {
  markers: readonly Marker[];
  w: number;
  h: number;
  pps: number;
  scrollMs: number;
  color: string;
  textColor: string;
  selectColor: string;
  selected: ReadonlySet<string>;
  /** A marker being dragged, shown at its preview position (ms shift). */
  drag?: { id: string; deltaMs: number } | null;
}

function clippedText(c: CanvasRenderingContext2D, s: string, x: number, y: number, maxW: number) {
  if (maxW < 12) return;
  let out = s;
  if (typeof c.measureText === "function") {
    while (out.length > 1 && c.measureText(out).width > maxW) out = out.slice(0, -1);
    if (out.length < s.length && out.length > 1) out = `${out.slice(0, -1)}…`;
    if (c.measureText(out).width > maxW) return;
  }
  c.fillText(out, x, y);
}

/** Paints one marker lane: ticks (height ∝ strength), ranges with labels, labels on custom markers. */
export function drawMarkerLane(c: CanvasRenderingContext2D, o: MarkerDrawOptions): void {
  const { w, h, pps, scrollMs } = o;
  const from = scrollMs - 100;
  const to = scrollMs + (w * 1000) / pps + 100;
  const list = o.markers;
  const vis = visibleMarkers(list, from, to);
  c.font = FONT;
  c.textBaseline = "middle";
  for (let i = 0; i < vis.length; i++) {
    const m = vis[i] as Marker;
    const shift = o.drag && o.drag.id === m.id ? o.drag.deltaMs : 0;
    const x0 = msToX(m.ms + shift, pps, scrollMs);
    const sel = o.selected.has(m.id);
    c.fillStyle = o.color;
    if (isRanged(m)) {
      const x1 = msToX((m.endMs as number) + shift, pps, scrollMs);
      const bw = Math.max(1, x1 - x0);
      c.globalAlpha = sel ? 0.45 : 0.24;
      c.fillRect(x0, 2, bw, h - 4);
      c.globalAlpha = 1;
      c.fillRect(x0, 1, 2, h - 2);
      if (m.label && bw > 24) {
        c.save();
        c.beginPath();
        c.rect(x0, 0, bw, h);
        c.clip();
        c.fillStyle = o.textColor;
        clippedText(c, m.label, x0 + 5, h / 2 + 0.5, bw - 8);
        c.restore();
      }
      if (sel) {
        c.strokeStyle = o.selectColor;
        c.lineWidth = 1;
        c.strokeRect(x0 + 0.5, 1.5, bw - 1, h - 3);
      }
    } else {
      const th = Math.max(4, Math.round((h - 2) * (0.35 + 0.65 * m.strength)));
      const x = Math.round(x0);
      c.globalAlpha = RANGED_LANES.has(m.lane) ? 1 : 0.55 + 0.45 * m.strength;
      c.fillRect(x - 1, h - 1 - th, 2, th);
      c.globalAlpha = 1;
      if (m.moved) c.fillRect(x - 2, 0, 4, 2);
      if (sel) {
        c.fillStyle = o.selectColor;
        c.fillRect(x - 2, h - 2 - th, 4, 1);
        c.fillRect(x - 2, h - 1, 4, 1);
        c.fillRect(x - 2, h - 1 - th, 1, th);
        c.fillRect(x + 1, h - 1 - th, 1, th);
      }
      if (m.lane === "custom" && m.label) {
        const nextX = vis[i + 1] ? msToX((vis[i + 1] as Marker).ms, pps, scrollMs) : w;
        c.fillStyle = o.textColor;
        clippedText(c, m.label, x + 5, h / 2 + 0.5, Math.min(w - x - 4, nextX - x - 8));
      }
    }
  }
}

/** Paints the whole-song peaks for the window (song ms = songStartMs + timeline ms). */
export function drawPeaks(
  c: CanvasRenderingContext2D,
  peaks: readonly number[],
  o: { w: number; h: number; pps: number; scrollMs: number; songStartMs: number; songDurationMs: number; color: string; rangeMs: number },
): void {
  const n = peaks.length;
  if (!n || o.songDurationMs <= 0) return;
  const { w, h, pps } = o;
  const mid = h / 2;
  c.fillStyle = o.color;
  for (let x = 0; x < w; x++) {
    const t0 = o.songStartMs + o.scrollMs + (x * 1000) / pps;
    const t1 = t0 + 1000 / pps;
    if (t1 < o.songStartMs || t0 > o.songStartMs + o.rangeMs) continue;
    const i0 = Math.max(0, Math.floor((t0 / o.songDurationMs) * n));
    const i1 = Math.min(n, Math.max(i0 + 1, Math.ceil((t1 / o.songDurationMs) * n)));
    let m = 0;
    for (let i = i0; i < i1; i++) m = Math.max(m, Math.abs(peaks[i] ?? 0));
    const bh = Math.max(1, m * (h - 2));
    c.fillRect(x, mid - bh / 2, 1, bh);
  }
}
