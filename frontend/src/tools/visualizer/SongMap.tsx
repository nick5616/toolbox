/**
 * The Song Map (SPEC.md §8.2): sections, beats/bars, instrument lanes,
 * chords, mood and lyrics on one zoomable time axis with a playhead.
 * CONTRACT (foundation): UI-V1 implements it; UI-V2 embeds it in the designer
 * (seeking, the selection for Export, and editable sections for the Timeline tab).
 *
 * Behaviour:
 *  - Each lane is a canvas that paints only the visible window; it redraws on
 *    resize, zoom, scroll and data changes, never on playhead ticks.
 *  - The playhead and the selection are separate overlay elements.
 *  - Ctrl/Cmd+wheel zooms around the pointer, the wheel and the scrollbar pan,
 *    a click or drag seeks, Shift-drag selects a range (a short Shift-click clears it).
 *  - `onSectionClick(i)`: `i` indexes the blocks shown on the sections lane
 *    (the timeline's scenes when `timeline` is given, else the analysis sections).
 *  - Lanes without data are not rendered.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { IconButton, cx } from "@/components";
import { formatMs } from "@/components/media";
import type { Analysis } from "@/viz/analysis";
import type { TimelineEntry } from "@/viz/types";
import { drawLane, readTheme } from "./songmap/draw";
import {
  blockIndexAt,
  clampPxPerSec,
  contentWidth,
  LANE_HEIGHT,
  LANE_LABEL,
  LABEL_WIDTH,
  pxPerSecFit,
  RULER_HEIGHT,
  scrollForAnchor,
  sectionBlocks,
  selectionFromDrag,
  timeAtX,
  viewFor,
  visibleLanes,
  xAtTime,
} from "./songmap/model";
import styles from "./SongMap.module.css";

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

const FALLBACK_WIDTH = 800;
const ZOOM_STEP = 1.6;

type Drag = { mode: "seek" } | { mode: "select"; fromMs: number };

export function SongMap({ analysis, timeline, playheadMs, onSeek, selection, onSelect, onSectionClick, lanes, className }: SongMapProps) {
  const duration = Math.max(1, analysis.durationMs);
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvases = useRef(new Map<string, HTMLCanvasElement>());
  const [viewW, setViewW] = useState(0);
  const [zoomPx, setZoomPx] = useState<number | null>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [draft, setDraft] = useState<{ startMs: number; endMs: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  const pendingScroll = useRef<number | null>(null);
  const lastPlayheadPx = useRef(0);

  const width = viewW || FALLBACK_WIDTH;
  const fit = pxPerSecFit(width, duration);
  const pps = zoomPx == null ? fit : clampPxPerSec(zoomPx, width, duration);
  const total = contentWidth(pps, duration);
  const maxScroll = Math.max(0, total - width);
  const effScroll = Math.min(scrollLeft, maxScroll);
  const zoomed = pps > fit * 1.001;

  const laneIds = useMemo(() => visibleLanes(analysis, lanes, timeline), [analysis, lanes, timeline]);
  const blocks = useMemo(() => sectionBlocks(analysis, timeline), [analysis, timeline]);
  const tops = useMemo(() => {
    const out: Record<string, number> = {};
    let y = RULER_HEIGHT;
    for (const l of laneIds) {
      out[l] = y;
      y += LANE_HEIGHT[l];
    }
    return { byLane: out, total: y };
  }, [laneIds]);

  // ---- measure the viewport ----
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setViewW(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- keep the zoom anchor after the track width changed ----
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el || pendingScroll.current == null) return;
    el.scrollLeft = pendingScroll.current;
    setScrollLeft(el.scrollLeft);
    pendingScroll.current = null;
  }, [pps]);

  const zoomTo = useCallback(
    (nextPx: number, anchorX: number) => {
      const el = viewportRef.current;
      const cur = el ? Math.min(el.scrollLeft, maxScroll) : effScroll;
      const anchorMs = timeAtX(anchorX, cur, pps, duration);
      const clamped = clampPxPerSec(nextPx, width, duration);
      pendingScroll.current = scrollForAnchor(anchorMs, anchorX, clamped, width, duration);
      setZoomPx(clamped <= fit * 1.001 ? null : clamped);
    },
    [duration, effScroll, fit, maxScroll, pps, width],
  );
  const zoomRef = useRef(zoomTo);
  zoomRef.current = zoomTo;
  const ppsRef = useRef(pps);
  ppsRef.current = pps;

  // ---- wheel: Ctrl/Cmd zooms around the pointer, the plain wheel pans ----
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        zoomRef.current(ppsRef.current * Math.exp(-e.deltaY * 0.0025), e.clientX - rect.left);
      } else if (e.deltaX === 0 && e.deltaY !== 0 && el.scrollWidth > el.clientWidth) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ---- paint the lanes (not on playhead ticks) ----
  const dpr = typeof window === "undefined" ? 1 : Math.max(1, window.devicePixelRatio || 1);
  useEffect(() => {
    const theme = readTheme(viewportRef.current);
    const view = viewFor(effScroll, width, pps, duration);
    for (const lane of ["ruler", ...laneIds] as const) {
      const canvas = canvases.current.get(lane);
      if (!canvas) continue;
      const h = lane === "ruler" ? RULER_HEIGHT : LANE_HEIGHT[lane];
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawLane(ctx, lane, analysis, view, pps, width, h, theme, timeline);
    }
  }, [analysis, timeline, laneIds, pps, effScroll, width, duration, dpr]);

  // ---- follow the playhead when playback runs off the right edge ----
  const playheadPx = xAtTime(playheadMs, effScroll, pps);
  useEffect(() => {
    const el = viewportRef.current;
    const prev = lastPlayheadPx.current;
    lastPlayheadPx.current = playheadPx;
    if (!el || !zoomed || drag.current) return;
    if (playheadPx > width && prev >= 0 && prev <= width) {
      el.scrollLeft = Math.min(maxScroll, (playheadMs / 1000) * pps - width * 0.15);
    }
  }, [playheadPx, playheadMs, zoomed, width, maxScroll, pps]);

  // ---- pointer ----
  const localX = (clientX: number) => clientX - (stageRef.current?.getBoundingClientRect().left ?? 0);
  const msAt = (clientX: number) => timeAtX(localX(clientX), effScroll, pps, duration);

  const onMouseDown = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    const ms = msAt(e.clientX);
    if (e.shiftKey) {
      drag.current = { mode: "select", fromMs: ms };
      setDraft({ startMs: ms, endMs: ms });
    } else {
      drag.current = { mode: "seek" };
      onSeek(Math.round(ms));
      if (onSectionClick) {
        const y = e.clientY - (stageRef.current?.getBoundingClientRect().top ?? 0);
        const top = tops.byLane.sections;
        if (top !== undefined && y >= top && y < top + LANE_HEIGHT.sections) {
          const i = blockIndexAt(blocks, ms);
          if (i >= 0) onSectionClick(i);
        }
      }
    }
    const move = (ev: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const t = msAt(ev.clientX);
      if (d.mode === "seek") onSeek(Math.round(t));
      else setDraft({ startMs: Math.min(d.fromMs, t), endMs: Math.max(d.fromMs, t) });
    };
    const up = (ev: MouseEvent) => {
      const d = drag.current;
      drag.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (d?.mode === "select") {
        setDraft(null);
        onSelect?.(selectionFromDrag(d.fromMs, msAt(ev.clientX)));
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    e.preventDefault();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 5000 : 1000;
    if (e.key === "ArrowRight") onSeek(Math.min(duration, playheadMs + step));
    else if (e.key === "ArrowLeft") onSeek(Math.max(0, playheadMs - step));
    else if (e.key === "Home") onSeek(0);
    else if (e.key === "End") onSeek(duration);
    else if (e.key === "Escape" && selection && onSelect) onSelect(null);
    else return;
    e.preventDefault();
  };

  const shown = draft ?? selection ?? null;
  const setCanvas = (id: string) => (el: HTMLCanvasElement | null) => {
    if (el) canvases.current.set(id, el);
    else canvases.current.delete(id);
  };

  return (
    <div className={cx(styles.root, className)} role="group" aria-label="Song map">
      <div className={styles.toolbar}>
        <span className={styles.hint}>Ctrl + wheel to zoom · Shift + drag to select a range</span>
        {selection && onSelect && (
          <button type="button" className={styles.clear} onClick={() => onSelect(null)}>
            Clear selection
          </button>
        )}
        <IconButton size="sm" icon="zoom-out" label="Zoom out" disabled={!zoomed} onClick={() => zoomTo(pps / ZOOM_STEP, width / 2)} />
        <IconButton size="sm" icon="zoom-in" label="Zoom in" onClick={() => zoomTo(pps * ZOOM_STEP, width / 2)} />
        <IconButton size="sm" icon="maximize" label="Fit the whole song" disabled={!zoomed} onClick={() => zoomTo(fit, width / 2)} />
      </div>
      <div className={styles.body}>
        <div className={styles.labels} style={{ width: LABEL_WIDTH }} aria-hidden="true">
          <div style={{ height: RULER_HEIGHT }} />
          {laneIds.map((l) => (
            <div key={l} className={styles.label} style={{ height: LANE_HEIGHT[l] }}>
              {LANE_LABEL[l]}
            </div>
          ))}
        </div>
        <div
          ref={viewportRef}
          className={styles.viewport}
          tabIndex={0}
          role="slider"
          aria-label="Song position"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(Math.min(duration, Math.max(0, playheadMs)))}
          aria-valuetext={formatMs(playheadMs)}
          onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
          onKeyDown={onKeyDown}
        >
          <div className={styles.track} style={{ width: total, height: tops.total }}>
            <div ref={stageRef} className={styles.stage} style={{ width, height: tops.total }} onMouseDown={onMouseDown} data-testid="songmap-stage">
              <canvas ref={setCanvas("ruler")} role="img" aria-label="Time ruler" className={styles.canvas} style={{ width, height: RULER_HEIGHT }} />
              {laneIds.map((l) => (
                <canvas
                  key={l}
                  ref={setCanvas(l)}
                  role="img"
                  aria-label={`${LANE_LABEL[l]} lane`}
                  data-lane={l}
                  className={styles.canvas}
                  style={{ width, height: LANE_HEIGHT[l] }}
                />
              ))}
              {shown && shown.endMs > shown.startMs && (
                <div
                  className={styles.selection}
                  data-testid="songmap-selection"
                  style={{
                    left: Math.max(0, xAtTime(shown.startMs, effScroll, pps)),
                    width: Math.max(1, Math.min(width, xAtTime(shown.endMs, effScroll, pps)) - Math.max(0, xAtTime(shown.startMs, effScroll, pps))),
                  }}
                />
              )}
              {playheadPx >= -1 && playheadPx <= width + 1 && (
                <div className={styles.playhead} data-testid="songmap-playhead" data-ms={Math.round(playheadMs)} style={{ transform: `translateX(${playheadPx}px)` }} />
              )}
            </div>
          </div>
        </div>
      </div>
      {onSectionClick && (
        <ul className={styles.srOnly} aria-label="Sections">
          {blocks.map((b, i) => (
            <li key={`${b.startMs}-${i}`}>
              <button
                type="button"
                onClick={() => {
                  onSeek(b.startMs);
                  onSectionClick(i);
                }}
              >
                {b.label}, {formatMs(b.startMs)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
