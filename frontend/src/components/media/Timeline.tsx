import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { cx } from "../cx";
import { formatDuration } from "@/lib/format";
import { Waveform } from "./Waveform";
import {
  clamp,
  clampView,
  DEFAULT_FRAME_MS,
  moveRangeEdge,
  msToPx,
  nudgeRangeEdge,
  panView,
  pxToMs,
  rulerStep,
  zoomView,
  type Edge,
  type View,
} from "./logic";
import type { Marker, Range } from "./types";
import styles from "./Timeline.module.css";

export interface TimelineProps {
  durationMs: number;
  playheadMs: number;
  onSeek: (ms: number) => void;
  /** A horizontal sprite from MediaService.Filmstrip. */
  filmstripUrl?: string;
  /** Peaks 0..1 from MediaService.Waveform. */
  waveform?: number[];
  ranges?: Range[];
  onRangesChange?: (ranges: Range[]) => void;
  selectedRange?: string;
  onSelectRange?: (id: string) => void;
  /** Keyframe times (ms), drawn as ticks when zoomed in. */
  keyframes?: number[];
  markers?: Marker[];
  onMarkerClick?: (id: string) => void;
  /** Frame duration for keyboard nudges (ms); default 1000/30. */
  frameMs?: number;
  zoomable?: boolean;
  className?: string;
}

const MAX_KEYFRAME_TICKS = 400;
const WHEEL_ZOOM_STEP = 1.0015;

interface Drag {
  kind: "seek" | "edge";
  id?: string;
  edge?: Edge;
  pointerId: number;
}

/** Filmstrip/waveform track with ranges, markers and a playhead (SPEC.md §3.11). */
export function Timeline({
  durationMs,
  playheadMs,
  onSeek,
  filmstripUrl,
  waveform,
  ranges,
  onRangesChange,
  selectedRange,
  onSelectRange,
  keyframes,
  markers,
  onMarkerClick,
  frameMs = DEFAULT_FRAME_MS,
  zoomable = false,
  className,
}: TimelineProps) {
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [view, setView] = useState<View>({ startMs: 0, spanMs: Math.max(1, durationMs) });
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);

  const list = ranges ?? [];
  const live = useRef({ ranges: list, view, width, playheadMs, durationMs, onRangesChange, onSeek, frameMs });
  live.current = { ranges: list, view, width, playheadMs, durationMs, onRangesChange, onSeek, frameMs };

  // Reset the view when the media changes.
  useEffect(() => {
    setView({ startMs: 0, spanMs: Math.max(1, durationMs) });
  }, [durationMs]);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the playhead visible while it moves.
  useEffect(() => {
    if (drag.current) return;
    setView((v) => {
      if (playheadMs >= v.startMs && playheadMs <= v.startMs + v.spanMs) return v;
      if (v.spanMs >= durationMs) return v;
      return clampView({ ...v, startMs: playheadMs - v.spanMs * 0.1 }, durationMs);
    });
  }, [playheadMs, durationMs]);

  // Wheel: Ctrl+wheel zooms, plain/Shift wheel pans. Non-passive so we can preventDefault.
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const { view: v, width: w, durationMs: d } = live.current;
      if (w <= 0 || d <= 0) return;
      if (e.ctrlKey || e.metaKey) {
        if (!zoomable) return;
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const frac = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
        setView(zoomView(v, d, frac, Math.pow(WHEEL_ZOOM_STEP, -e.deltaY)));
        return;
      }
      if (v.spanMs >= d) return;
      e.preventDefault();
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      setView(panView(v, d, (delta / w) * v.spanMs));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomable]);

  const msAt = (clientX: number): number => {
    const el = track.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.round(clamp(pxToMs(clientX - r.left, live.current.view, r.width || live.current.width), 0, live.current.durationMs));
  };

  const onTrackDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current) return;
    drag.current = { kind: "seek", pointerId: e.pointerId };
    setDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    live.current.onSeek(msAt(e.clientX));
  };

  const onEdgeDown = (e: RPointerEvent<HTMLDivElement>, id: string, edge: Edge) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    drag.current = { kind: "edge", id, edge, pointerId: e.pointerId };
    setDragging(true);
    onSelectRange?.(id);
    track.current?.setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const ms = msAt(e.clientX);
    if (d.kind === "seek") {
      live.current.onSeek(ms);
      return;
    }
    const l = live.current;
    if (!d.id || !d.edge || !l.onRangesChange) return;
    const msPerPx = l.width > 0 ? l.view.spanMs / l.width : 0;
    l.onRangesChange(
      moveRangeEdge(l.ranges, d.id, d.edge, ms, {
        durationMs: l.durationMs,
        playheadMs: l.playheadMs,
        msPerPx,
        minMs: l.frameMs,
        noSnap: e.altKey,
      }),
    );
  };

  const endDrag = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    track.current?.releasePointerCapture?.(e.pointerId);
  };

  const onEdgeKey = (e: KeyboardEvent<HTMLDivElement>, id: string, edge: Edge) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? 1000 : live.current.frameMs;
    const delta = e.key === "ArrowLeft" ? -step : step;
    const l = live.current;
    l.onRangesChange?.(nudgeRangeEdge(l.ranges, id, edge, delta, { durationMs: l.durationMs, minMs: l.frameMs }));
  };

  // Derived drawing data.
  const visibleWave = useMemo(() => {
    if (!waveform || waveform.length === 0 || durationMs <= 0) return null;
    const n = waveform.length;
    const from = clamp(Math.floor((view.startMs / durationMs) * n), 0, n - 1);
    const to = clamp(Math.ceil(((view.startMs + view.spanMs) / durationMs) * n), from + 1, n);
    return waveform.slice(from, to);
  }, [waveform, view, durationMs]);

  const ticks = useMemo(() => {
    const out: number[] = [];
    if (width <= 0) return out;
    const step = rulerStep(view.spanMs, width);
    for (let t = Math.ceil(view.startMs / step) * step; t <= view.startMs + view.spanMs; t += step) out.push(t);
    return out;
  }, [view, width]);

  const kfTicks = useMemo(() => {
    if (!keyframes || keyframes.length === 0) return [];
    if (view.spanMs >= durationMs * 0.5 && durationMs > 60_000) return []; // zoomed out: too dense to help
    const vis = keyframes.filter((k) => k >= view.startMs && k <= view.startMs + view.spanMs);
    return vis.length <= MAX_KEYFRAME_TICKS ? vis : [];
  }, [keyframes, view, durationMs]);

  const total = view.spanMs > 0 ? (durationMs / view.spanMs) * width : width;
  const stripStyle = filmstripUrl
    ? {
        backgroundImage: `url("${filmstripUrl}")`,
        backgroundSize: `${total}px 100%`,
        backgroundPosition: `${msToPx(0, view, width)}px 0`,
      }
    : undefined;

  return (
    <div className={cx(styles.root, className)} data-testid="timeline">
      <div className={styles.ruler} aria-hidden="true">
        {ticks.map((t) => (
          <span key={t} className={styles.tick} style={{ left: msToPx(t, view, width) }}>
            {formatDuration(t / 1000)}
          </span>
        ))}
      </div>
      <div
        ref={track}
        className={cx(styles.track, dragging && styles.dragging)}
        onPointerDown={onTrackDown}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {filmstripUrl && <div className={styles.strip} style={stripStyle} />}
        {visibleWave && (
          <Waveform peaks={visibleWave} height={filmstripUrl ? 56 : 56} className={cx(styles.wave, filmstripUrl && styles.waveOver)} />
        )}
        {kfTicks.map((k) => (
          <span key={k} className={styles.keyframe} style={{ left: msToPx(k, view, width) }} />
        ))}
        {list.map((r) => {
          const left = msToPx(r.startMs, view, width);
          const right = msToPx(r.endMs, view, width);
          const selected = r.id === selectedRange;
          return (
            <div
              key={r.id}
              data-testid={`range-${r.id}`}
              className={cx(styles.range, selected && styles.selected)}
              style={{ left, width: Math.max(2, right - left) }}
              onPointerDown={(e) => {
                // Select without seeking; the track handler is skipped.
                if (e.button !== 0) return;
                e.stopPropagation();
                onSelectRange?.(r.id);
                if (!drag.current) {
                  drag.current = { kind: "seek", pointerId: e.pointerId };
                  setDragging(true);
                  track.current?.setPointerCapture?.(e.pointerId);
                  live.current.onSeek(msAt(e.clientX));
                }
              }}
            >
              {r.label && <span className={styles.rangeLabel}>{r.label}</span>}
              {(["start", "end"] as const).map((edge) => (
                <div
                  key={edge}
                  role="slider"
                  tabIndex={0}
                  aria-label={`${edge === "start" ? "Start" : "End"} of ${r.label ?? "range"}`}
                  aria-valuemin={0}
                  aria-valuemax={durationMs}
                  aria-valuenow={Math.round(edge === "start" ? r.startMs : r.endMs)}
                  className={cx(styles.handle, edge === "start" ? styles.handleStart : styles.handleEnd)}
                  onPointerDown={(e) => onEdgeDown(e, r.id, edge)}
                  onKeyDown={(e) => onEdgeKey(e, r.id, edge)}
                  onFocus={() => onSelectRange?.(r.id)}
                />
              ))}
            </div>
          );
        })}
        <div className={styles.playhead} style={{ left: msToPx(playheadMs, view, width) }} aria-hidden="true" />
      </div>
      {markers && markers.length > 0 && (
        <div className={styles.markers}>
          {markers.map((m) => {
            const left = msToPx(m.startMs, view, width);
            const w = m.endMs !== undefined ? Math.max(3, msToPx(m.endMs, view, width) - left) : 3;
            if (left + w < 0 || left > width) return null;
            return (
              <button
                key={m.id}
                type="button"
                title={m.label}
                aria-label={m.label ?? "Marker"}
                className={cx(styles.marker, styles[`tone_${m.tone ?? "neutral"}`])}
                style={{ left, width: w }}
                onClick={() => onMarkerClick?.(m.id)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
