// Pure maths for the media kit (SPEC.md §3.11): easy to table-test.
import type { Box, ContentRect, Range } from "./types";

export const SNAP_PX = 6;
export const DEFAULT_FRAME_MS = 1000 / 30;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The rectangle of an object-fit: contain picture inside a box. */
export function computeContentRect(boxW: number, boxH: number, srcW: number, srcH: number): ContentRect {
  if (!(boxW > 0) || !(boxH > 0)) return { left: 0, top: 0, width: 0, height: 0 };
  if (!(srcW > 0) || !(srcH > 0)) return { left: 0, top: 0, width: boxW, height: boxH };
  const scale = Math.min(boxW / srcW, boxH / srcH);
  const width = srcW * scale;
  const height = srcH * scale;
  return { left: (boxW - width) / 2, top: (boxH - height) / 2, width, height };
}

export function sameRect(a: ContentRect, b: ContentRect): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

// ---- Player keys ----

export type PlayerKeyAction =
  | { type: "toggle" }
  | { type: "seekBy"; ms: number }
  | { type: "step"; frames: number }
  | { type: "home" }
  | { type: "end" };

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** Maps a key press to a player action (null = not ours). */
export function playerKeyAction(e: KeyLike): PlayerKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const shift = !!e.shiftKey;
  switch (e.key) {
    case " ":
      return { type: "toggle" };
    case ",":
    case "<":
      return shift ? { type: "seekBy", ms: -1000 } : { type: "step", frames: -1 };
    case ".":
    case ">":
      return shift ? { type: "seekBy", ms: 1000 } : { type: "step", frames: 1 };
    case "ArrowLeft":
      return { type: "seekBy", ms: -5000 };
    case "ArrowRight":
      return { type: "seekBy", ms: 5000 };
    case "Home":
      return { type: "home" };
    case "End":
      return { type: "end" };
    default:
      return null;
  }
}

/** True for elements where typed keys belong to the element, not the player. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable) return true;
  if (tag === "INPUT") {
    const type = (t as HTMLInputElement).type;
    return type !== "range" && type !== "checkbox" && type !== "radio" && type !== "button";
  }
  return false;
}

/** Elements that act on Space/Enter themselves. */
export function isActivatable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "BUTTON" || tag === "A" || tag === "INPUT" || t.getAttribute("role") === "slider";
}

/** Range inputs and role=slider elements (Timeline handles) use the arrow keys themselves. */
export function isSliderTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.getAttribute("role") === "slider" || (t instanceof HTMLInputElement && t.type === "range");
}

export function frameMsFor(fps: number | undefined | null): number {
  return fps && fps > 0 ? 1000 / fps : DEFAULT_FRAME_MS;
}

// ---- Timecodes ----

/** "1:05.250" style. */
export function formatMs(ms: number): string {
  const t = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const f = t % 1000;
  const ss = String(s).padStart(2, "0");
  const frac = String(f).padStart(3, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}.${frac}` : `${m}:${ss}.${frac}`;
}

/** Parses "90", "1:05.5", "1:02:03.25" into ms; null when invalid. */
export function parseTimecodeMs(text: string): number | null {
  const s = text.trim();
  if (!s) return null;
  const parts = s.split(":");
  if (parts.length > 3) return null;
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? "";
    const last = i === parts.length - 1;
    if (!(last ? /^(\d+(\.\d*)?|\.\d+)$/ : /^\d+$/).test(p)) return null;
    total = total * 60 + Number(p);
  }
  return Math.round(total * 1000);
}

// ---- Timeline view / zoom ----

export interface View {
  startMs: number;
  spanMs: number;
}

export const MAX_ZOOM = 200;

export function clampView(v: View, durationMs: number): View {
  const minSpan = Math.min(durationMs, Math.max(100, durationMs / MAX_ZOOM));
  const spanMs = clamp(v.spanMs, minSpan, Math.max(durationMs, minSpan));
  return { spanMs, startMs: clamp(v.startMs, 0, Math.max(0, durationMs - spanMs)) };
}

/** Zooms by factor (>1 zooms in) keeping the time under anchorFraction (0..1 of the width) fixed. */
export function zoomView(v: View, durationMs: number, anchorFraction: number, factor: number): View {
  const f = clamp(anchorFraction, 0, 1);
  const anchorMs = v.startMs + f * v.spanMs;
  const spanMs = v.spanMs / factor;
  return clampView({ spanMs, startMs: anchorMs - f * spanMs }, durationMs);
}

export function panView(v: View, durationMs: number, deltaMs: number): View {
  return clampView({ ...v, startMs: v.startMs + deltaMs }, durationMs);
}

export function msToPx(ms: number, v: View, widthPx: number): number {
  return v.spanMs > 0 ? ((ms - v.startMs) / v.spanMs) * widthPx : 0;
}

export function pxToMs(px: number, v: View, widthPx: number): number {
  return widthPx > 0 ? v.startMs + (px / widthPx) * v.spanMs : v.startMs;
}

// ---- Ranges ----

/** Snaps to the playhead when within snapPx pixels. */
export function snapToPlayhead(ms: number, playheadMs: number, msPerPx: number, snapPx: number = SNAP_PX): number {
  return Math.abs(ms - playheadMs) <= snapPx * msPerPx ? playheadMs : ms;
}

export type Edge = "start" | "end";

export interface MoveEdgeOpts {
  durationMs: number;
  playheadMs: number;
  msPerPx: number;
  /** Minimum range length (default one frame). */
  minMs: number;
  /** Disable snapping (e.g. Alt held). */
  noSnap?: boolean;
}

/**
 * Moves one edge of a range to `ms`: snaps to the playhead, clamps to
 * [0, duration] and keeps at least minMs of length. Other ranges are not
 * touched (callers decide about overlap).
 */
export function moveRangeEdge(ranges: Range[], id: string, edge: Edge, ms: number, o: MoveEdgeOpts): Range[] {
  return ranges.map((r) => {
    if (r.id !== id) return r;
    const snapped = o.noSnap ? ms : snapToPlayhead(ms, o.playheadMs, o.msPerPx);
    if (edge === "start") {
      const startMs = clamp(snapped, 0, Math.max(0, r.endMs - o.minMs));
      return { ...r, startMs };
    }
    const endMs = clamp(snapped, Math.min(o.durationMs, r.startMs + o.minMs), o.durationMs);
    return { ...r, endMs };
  });
}

/** Keyboard nudge of one edge by deltaMs (no snapping). */
export function nudgeRangeEdge(
  ranges: Range[],
  id: string,
  edge: Edge,
  deltaMs: number,
  o: { durationMs: number; minMs: number },
): Range[] {
  const r = ranges.find((x) => x.id === id);
  if (!r) return ranges;
  const cur = edge === "start" ? r.startMs : r.endMs;
  return moveRangeEdge(ranges, id, edge, cur + deltaMs, { ...o, msPerPx: 0, playheadMs: 0, noSnap: true });
}

// ---- Ruler ----

const RULER_STEPS_MS = [100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000];

/** A readable tick spacing giving roughly one tick per targetPx. */
export function rulerStep(spanMs: number, widthPx: number, targetPx = 90): number {
  const want = widthPx > 0 ? (spanMs / widthPx) * targetPx : spanMs;
  return RULER_STEPS_MS.find((s) => s >= want) ?? 3_600_000;
}

// ---- Boxes ----

export type Corner = "nw" | "ne" | "sw" | "se";
export const MIN_BOX = 0.01;

export function normalizeBox(x0: number, y0: number, x1: number, y1: number): { x: number; y: number; w: number; h: number } {
  const ax = clamp(Math.min(x0, x1), 0, 1);
  const ay = clamp(Math.min(y0, y1), 0, 1);
  const bx = clamp(Math.max(x0, x1), 0, 1);
  const by = clamp(Math.max(y0, y1), 0, 1);
  return { x: ax, y: ay, w: bx - ax, h: by - ay };
}

/** Resizes a box by dragging one corner to (px, py) in 0..1 coordinates. */
export function resizeBox(b: Box, corner: Corner, px: number, py: number): Box {
  const x = clamp(px, 0, 1);
  const y = clamp(py, 0, 1);
  let left = b.x;
  let top = b.y;
  let right = b.x + b.w;
  let bottom = b.y + b.h;
  if (corner === "nw" || corner === "sw") left = Math.min(x, right - MIN_BOX);
  else right = Math.max(x, left + MIN_BOX);
  if (corner === "nw" || corner === "ne") top = Math.min(y, bottom - MIN_BOX);
  else bottom = Math.max(y, top + MIN_BOX);
  return { ...b, x: left, y: top, w: right - left, h: bottom - top };
}

let manualSeq = 0;
export function newManualBoxId(): string {
  manualSeq += 1;
  return `manual-${Date.now().toString(36)}-${manualSeq}`;
}

// ---- Crop ----

/**
 * Size (0..1 of the picture) of the crop window: full height, or full width
 * when the target is wider than the source.
 */
export function cropWindow(aspect: number, sourceAspect: number): { w: number; h: number } {
  if (!(aspect > 0) || !(sourceAspect > 0)) return { w: 1, h: 1 };
  if (aspect >= sourceAspect) return { w: 1, h: sourceAspect / aspect };
  return { w: aspect / sourceAspect, h: 1 };
}

/** Clamps the window centre so the window stays inside the picture. */
export function clampCropCenter(x: number, y: number, win: { w: number; h: number }): { x: number; y: number } {
  return {
    x: clamp(x, win.w / 2, 1 - win.w / 2),
    y: clamp(y, win.h / 2, 1 - win.h / 2),
  };
}
