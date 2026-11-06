// The timeline (SPEC.md Part B §B6.5): clips, titles and music lanes with a
// playhead, zoom and snapping.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import { Button, IconButton, SegmentedControl, Slider, cx } from "@/components";
import { Waveform } from "@/components/media";
import type { VideoClip, VideoClipInfo, VideoProject, VideoTitle } from "@/lib/api";
import { formatMs } from "@/components/media";
import { clipsOf, dropIndexAt, moveClip, setTransition, titlesOf, trimClip, updateTitle } from "./edit";
import {
  clampPps,
  musicPeaksWindow,
  reorderTarget,
  rulerStepSec,
  snapMs,
  snapPoints,
  titleRows,
  SNAP_PX,
} from "./panelLogic";
import { MAX_TRANSITION_MS, MIN_TRANSITION_MS, type Span } from "./timeline";
import { useSourceDropTarget } from "@/blocks/sources/sourceDrag";
import { useThumb, useWaveform } from "@/blocks/media/useThumbs";
import type { Selection } from "./types";
import styles from "./TimelinePanel.module.css";
import { useMiddleDragScroll } from "@/lib/useDragScroll";

export interface TimelinePanelProps {
  doc: VideoProject;
  spans: Span[];
  totalMs: number;
  timeMs: number;
  playing: boolean;
  selection: Selection;
  infos: Record<string, VideoClipInfo | undefined>;
  onSelect: (s: Selection) => void;
  onSeek: (ms: number) => void;
  /** key coalesces a drag into one undo step. */
  onChange: (next: VideoProject, key?: string) => void;
  onEditTitle: (id: string) => void;
  onAddClips: () => void;
  onAddTitle: () => void;
  onPickMusic: () => void;
  /** Post sources dropped on the clips lane: insert them as clips at index. */
  onDropSources?: (paths: string[], index: number) => void;
}

const LANE_PAD_MS = 1500;
const TITLE_ROW_H = 24;
const DRAG_START_PX = 4;

const TRANSITION_OPTIONS = [
  { value: "cut", label: "Cut", tip: "Jump straight to the next clip with no transition" },
  { value: "fade", label: "Fade", tip: "Cross-fade: the clips blend into each other" },
  { value: "dip", label: "Dip", tip: "Dip to black between the clips" },
  { value: "slide", label: "Slide", tip: "The next clip slides in over the previous one" },
] as const;

const TRANSITION_ICON: Record<string, string> = { cut: "scissors", fade: "blend", dip: "moon", slide: "arrow-right" };

function ClipThumb({ clip, stretch }: { clip: VideoClip; stretch: CSSProperties }) {
  const url = useThumb(clip.path, clip.kind);
  if (!url) return null;
  const style: CSSProperties =
    clip.kind === "image"
      ? { backgroundImage: `url("${url}")`, backgroundSize: "cover", backgroundPosition: "center" }
      : { backgroundImage: `url("${url}")`, ...stretch };
  return <div className={styles.thumb} style={style} aria-hidden="true" />;
}

/** Where in the sprite the clip's In..Out part sits. */
function stripStyle(clip: VideoClip, srcDurMs: number): CSSProperties {
  const len = clip.outMs - clip.inMs;
  if (srcDurMs <= 0 || len <= 0 || len >= srcDurMs) return { backgroundSize: "100% 100%", backgroundPosition: "0 0" };
  const pos = srcDurMs - len > 0 ? (clip.inMs / (srcDurMs - len)) * 100 : 0;
  return { backgroundSize: `${(srcDurMs / len) * 100}% 100%`, backgroundPosition: `${pos}% 0` };
}

interface TransitionPopover {
  index: number;
  x: number;
  y: number;
}

export function TimelinePanel(p: TimelinePanelProps) {
  const { doc, spans, totalMs, timeMs, selection, infos } = p;
  const clips = clipsOf(doc);
  const titles = titlesOf(doc);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => setScrollEl(scroller.current), []);
  useMiddleDragScroll(scrollEl);
  const [pps, setPps] = useState(60);
  const ppms = pps / 1000;
  const widthPx = Math.max(300, (totalMs + LANE_PAD_MS) * ppms);
  const [popover, setPopover] = useState<TransitionPopover | null>(null);
  const [drag, setDrag] = useState<{ index: number; dx: number; target: number } | null>(null);
  const live = useRef({ doc, spans, timeMs, ppms, onChange: p.onChange, onSeek: p.onSeek, onDropSources: p.onDropSources });
  live.current = { doc, spans, timeMs, ppms, onChange: p.onChange, onSeek: p.onSeek, onDropSources: p.onDropSources };

  const fit = () => {
    const w = scroller.current?.clientWidth ?? 600;
    setPps(clampPps(((w - 24) / Math.max(totalMs + LANE_PAD_MS / 2, 1000)) * 1000));
  };

  // The wheel zooms around the pointer.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // The wheel zooms around the pointer; Shift+wheel pans (sideways trackpad scrolling,
      // the scrollbar and a middle-button drag pan natively).
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (e.shiftKey) {
        e.preventDefault();
        el.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        return;
      }
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const anchorPx = e.clientX - rect.left + el.scrollLeft;
      const anchorMs = anchorPx / live.current.ppms;
      setPps((cur) => {
        const next = clampPps(cur * Math.exp(-e.deltaY * 0.0015));
        requestAnimationFrame(() => {
          el.scrollLeft = (anchorMs * next) / 1000 - (e.clientX - rect.left);
        });
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the playhead in view while playing.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !p.playing) return;
    const x = timeMs * ppms;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, x - 80);
  }, [timeMs, ppms, p.playing]);

  const clipLane = useRef<HTMLDivElement>(null);
  const onDropSources = useCallback((info: { paths: string[]; x: number }) => {
    const el = scroller.current;
    if (!el || !live.current.onDropSources) return;
    const rect = el.getBoundingClientRect();
    const ms = Math.max(0, (info.x - rect.left + el.scrollLeft) / live.current.ppms);
    live.current.onDropSources(info.paths, dropIndexAt(live.current.spans, ms));
  }, []);
  useSourceDropTarget(clipLane, onDropSources);

  const msAtClientX = (clientX: number): number => {
    const el = scroller.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left + el.scrollLeft) / ppms);
  };

  // --- seeking ---
  const seekDrag = useRef(false);
  const onRulerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    seekDrag.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    p.onSeek(Math.min(msAtClientX(e.clientX), totalMs));
  };
  const onRulerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (seekDrag.current) p.onSeek(Math.min(msAtClientX(e.clientX), totalMs));
  };
  const onRulerUp = (e: RPointerEvent<HTMLDivElement>) => {
    seekDrag.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  // --- clip move / trim ---
  const gesture = useRef<
    | { kind: "move"; index: number; startX: number; moved: boolean; pointerId: number }
    | { kind: "trim"; index: number; edge: "start" | "end"; startX: number; base: VideoProject; pointerId: number }
    | null
  >(null);

  const onClipDown = (e: RPointerEvent<HTMLDivElement>, index: number) => {
    if (e.button !== 0) return;
    const c = clips[index];
    if (!c) return;
    p.onSelect({ kind: "clip", id: c.id });
    p.onSeek(Math.min(msAtClientX(e.clientX), totalMs));
    gesture.current = { kind: "move", index, startX: e.clientX, moved: false, pointerId: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onTrimDown = (e: RPointerEvent<HTMLDivElement>, index: number, edge: "start" | "end") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const c = clips[index];
    if (c) p.onSelect({ kind: "clip", id: c.id });
    gesture.current = { kind: "trim", index, edge, startX: e.clientX, base: doc, pointerId: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onGestureMove = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const dx = e.clientX - g.startX;
    if (g.kind === "move") {
      if (!g.moved && Math.abs(dx) < DRAG_START_PX) return;
      g.moved = true;
      const s = live.current.spans[g.index];
      if (!s) return;
      const center = (s.startMs + s.endMs) / 2 + dx / live.current.ppms;
      setDrag({ index: g.index, dx, target: reorderTarget(live.current.spans, g.index, center) });
      return;
    }
    let delta = dx / live.current.ppms;
    const s = live.current.spans[g.index];
    const clip = clipsOf(g.base)[g.index];
    if (s && clip) {
      // Snap the moving edge to the playhead (and the start).
      const threshold = SNAP_PX / live.current.ppms;
      const edgeMs = g.edge === "end" ? s.endMs + delta : s.startMs + delta;
      const snapped = snapMs(edgeMs, [live.current.timeMs, 0], threshold);
      delta += snapped - edgeMs;
    }
    const srcDur = clip ? (infos[clip.path]?.durationMs ?? 0) : 0;
    live.current.onChange(trimClip(g.base, g.index, g.edge, Math.round(delta), srcDur), `trim-${g.index}-${g.edge}`);
  };
  const onGestureUp = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gesture.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (g.kind === "move" && g.moved) {
      const s = live.current.spans[g.index];
      if (s) {
        const dx = e.clientX - g.startX;
        const to = reorderTarget(live.current.spans, g.index, (s.startMs + s.endMs) / 2 + dx / live.current.ppms);
        if (to !== g.index) live.current.onChange(moveClip(live.current.doc, g.index, to));
      }
    }
    setDrag(null);
  };

  // --- titles ---
  const titleGesture = useRef<{
    id: string;
    mode: "move" | "start" | "end";
    startX: number;
    base: VideoProject;
    orig: VideoTitle;
    pointerId: number;
  } | null>(null);
  const onTitleDown = (e: RPointerEvent<HTMLDivElement>, t: VideoTitle, mode: "move" | "start" | "end") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    p.onSelect({ kind: "title", id: t.id });
    titleGesture.current = { id: t.id, mode, startX: e.clientX, base: doc, orig: t, pointerId: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onTitleMove = (e: RPointerEvent<HTMLDivElement>) => {
    const g = titleGesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const delta = (e.clientX - g.startX) / live.current.ppms;
    const threshold = SNAP_PX / live.current.ppms;
    const pts = snapPoints(live.current.spans, live.current.timeMs);
    const o = g.orig;
    let patch: Partial<VideoTitle>;
    if (g.mode === "move") {
      let start = o.startMs + delta;
      const sStart = snapMs(start, pts, threshold);
      const sEnd = snapMs(start + o.durationMs, pts, threshold) - o.durationMs;
      start = Math.abs(sStart - start) <= Math.abs(sEnd - start) && sStart !== start ? sStart : sEnd !== start ? sEnd : start;
      patch = { startMs: Math.max(0, start) };
    } else if (g.mode === "start") {
      const end = o.startMs + o.durationMs;
      const start = Math.min(snapMs(o.startMs + delta, pts, threshold), end - 500);
      patch = { startMs: Math.max(0, start), durationMs: end - Math.max(0, start) };
    } else {
      const end = snapMs(o.startMs + o.durationMs + delta, pts, threshold);
      patch = { durationMs: Math.max(500, end - o.startMs) };
    }
    live.current.onChange(updateTitle(g.base, g.id, patch), `title-${g.id}-${g.mode}`);
  };
  const onTitleUp = (e: RPointerEvent<HTMLDivElement>) => {
    if (titleGesture.current?.pointerId !== e.pointerId) return;
    titleGesture.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  // --- music ---
  const music = doc.music;
  const peaks = useWaveform(music?.path ?? null);
  const songMs = music ? (infos[music.path]?.durationMs ?? 0) : 0;
  const musicGesture = useRef<{ startX: number; base: number; pointerId: number } | null>(null);
  const musicPeaks = useMemo(
    () => (music ? musicPeaksWindow(peaks, songMs, music.offsetMs, totalMs) : []),
    [peaks, songMs, music, totalMs],
  );
  const onMusicDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !music) return;
    p.onSelect({ kind: "music" });
    musicGesture.current = { startX: e.clientX, base: music.offsetMs, pointerId: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMusicMove = (e: RPointerEvent<HTMLDivElement>) => {
    const g = musicGesture.current;
    const m = live.current.doc.music;
    if (!g || g.pointerId !== e.pointerId || !m) return;
    const dx = (e.clientX - g.startX) / live.current.ppms;
    const max = songMs > 0 ? Math.max(0, songMs - 1000) : Number.POSITIVE_INFINITY;
    const offsetMs = Math.round(Math.min(Math.max(g.base - dx, 0), max));
    live.current.onChange({ ...live.current.doc, music: { ...m, offsetMs } }, "music-offset");
  };
  const onMusicUp = (e: RPointerEvent<HTMLDivElement>) => {
    if (musicGesture.current?.pointerId !== e.pointerId) return;
    musicGesture.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  // --- ruler ticks ---
  const stepSec = rulerStepSec(pps);
  const ticks: number[] = [];
  for (let s = 0; s * 1000 <= totalMs + LANE_PAD_MS; s += stepSec) ticks.push(s);

  const rows = titleRows(titles);
  const rowCount = Math.max(1, ...[...rows.values()].map((r) => r + 1));
  const popClip = popover ? clips[popover.index] : undefined;
  const popNext = popover ? clips[popover.index + 1] : undefined;
  const popSpan = popover ? spans[popover.index] : undefined;
  const popLimit =
    popClip && popNext && popSpan
      ? Math.min(MAX_TRANSITION_MS, Math.floor(popSpan.lenMs / 2), Math.floor((spans[popover!.index + 1]?.lenMs ?? 0) / 2))
      : 0;

  return (
    <div className={styles.panel} data-testid="timeline-panel">
      <div className={styles.toolbar}>
        <Button size="sm" variant="ghost" icon="plus" data-tip="Add videos or photos to the end of the timeline" onClick={p.onAddClips}>
          Clips
        </Button>
        <Button size="sm" variant="ghost" icon="type" data-tip={clips.length === 0 ? "Add a clip first, then add text on top of it" : "Add a text title at the playhead"} onClick={p.onAddTitle} disabled={clips.length === 0}>
          Title
        </Button>
        <Button size="sm" variant="ghost" icon="music" data-tip={music ? "Replace the background song" : "Add a background song under the whole video"} onClick={p.onPickMusic}>
          {music ? "Change song" : "Song"}
        </Button>
        <span className={styles.spacer} />
        <IconButton size="sm" icon="zoom-out" label="Zoom out" data-tip="Show more time on the timeline (Ctrl + scroll also zooms)" onClick={() => setPps((v) => clampPps(v / 1.4))} />
        <IconButton size="sm" icon="zoom-in" label="Zoom in" data-tip="Show less time, larger clips (Ctrl + scroll also zooms)" onClick={() => setPps((v) => clampPps(v * 1.4))} />
        <IconButton size="sm" icon="maximize" label="Fit the whole video" data-tip="Zoom so the whole video fits the timeline" onClick={fit} />
      </div>
      <div className={styles.scroller} ref={scroller}>
        <div
          className={styles.canvas}
          style={{ width: widthPx }}
          onPointerDown={(e) => {
            // Empty space in any lane works like the ruler: click or drag moves the playhead.
            const t = e.target as HTMLElement;
            if (t === e.currentTarget || t.classList.contains(styles.lane as string) || t.classList.contains(styles.laneEmpty as string)) onRulerDown(e);
          }}
          onPointerMove={onRulerMove}
          onPointerUp={onRulerUp}
          onPointerCancel={onRulerUp}
        >
          <div className={styles.ruler} onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp} onPointerCancel={onRulerUp} data-testid="ruler" data-tip="Click or drag to move the playhead">
            {ticks.map((s) => (
              <span key={s} className={styles.tick} style={{ left: s * pps }}>
                {formatMs(s * 1000)}
              </span>
            ))}
          </div>

          <div className={cx(styles.lane, styles.clipLane)} data-testid="clips-lane" ref={clipLane} data-tip="Clips lane: drag to reorder, drag edges to trim, drop post sources here">
            {clips.map((c, i) => {
              const s = spans[i];
              if (!s) return null;
              const selected = selection?.kind === "clip" && selection.id === c.id;
              const info = infos[c.path];
              const dragging = drag?.index === i;
              const style: CSSProperties = {
                left: s.startMs * ppms,
                width: Math.max(8, s.lenMs * ppms),
                ...(dragging ? { transform: `translateX(${drag.dx}px)`, zIndex: 20, opacity: 0.85 } : {}),
              };
              return (
                <div
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Clip ${i + 1}`}
                  data-tip={`${c.path.split(/[\/]/).pop()}: click to select, drag to reorder, drag the edges to trim`}
                  aria-pressed={selected}
                  data-testid={`clip-${i}`}
                  className={cx(styles.clip, selected && styles.selected, info?.error && styles.missing)}
                  style={style}
                  onPointerDown={(e) => onClipDown(e, i)}
                  onPointerMove={onGestureMove}
                  onPointerUp={onGestureUp}
                  onPointerCancel={onGestureUp}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      p.onSelect({ kind: "clip", id: c.id });
                    }
                  }}
                >
                  <ClipThumb clip={c} stretch={stripStyle(c, info?.durationMs ?? 0)} />
                  <span className={styles.clipLabel}>
                    {c.path.split(/[\\/]/).pop()} · {(s.lenMs / 1000).toFixed(1)}s{c.speed !== 1 ? ` · ${c.speed}×` : ""}
                  </span>
                  <div className={cx(styles.handle, styles.handleStart)} data-tip="Drag to trim where the clip starts" data-testid={`trim-start-${i}`} onPointerDown={(e) => onTrimDown(e, i, "start")} />
                  <div className={cx(styles.handle, styles.handleEnd)} data-tip="Drag to trim where the clip ends" data-testid={`trim-end-${i}`} onPointerDown={(e) => onTrimDown(e, i, "end")} />
                </div>
              );
            })}
            {drag && (() => {
              const t = spans.filter((s) => s.index !== drag.index)[drag.target];
              const x = t ? t.startMs : (spans.at(-1)?.endMs ?? 0);
              return <div className={styles.dropMark} style={{ left: x * ppms }} aria-hidden="true" />;
            })()}
            {clips.slice(0, -1).map((c, i) => {
              const s = spans[i];
              const nx = spans[i + 1];
              if (!s || !nx) return null;
              const kind = c.transition.kind || "cut";
              return (
                <button
                  key={`tr-${c.id}`}
                  type="button"
                  className={cx(styles.chip, kind !== "cut" && styles.chipOn)}
                  style={{ left: (nx.startMs + s.overlapMs / 2) * ppms }}
                  aria-label={`Transition after clip ${i + 1}: ${kind}`}
                  data-tip={`Transition between clip ${i + 1} and ${i + 2} (${kind}): click to change it`}
                  data-testid={`transition-${i}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setPopover({ index: i, x: r.left + r.width / 2, y: r.top });
                  }}
                >
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <path d={chipPath(TRANSITION_ICON[kind] ?? "scissors")} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
              );
            })}
            {clips.length === 0 && <div className={styles.laneEmpty}>Drop clips and photos here, or use + Clips</div>}
          </div>

          <div className={cx(styles.lane, styles.titleLane)} style={{ height: rowCount * TITLE_ROW_H + 8 }} data-testid="titles-lane" data-tip="Titles lane: text shown over the video at these times">
            {titles.map((t) => {
              const selected = selection?.kind === "title" && selection.id === t.id;
              return (
                <div
                  key={t.id}
                  className={cx(styles.title, selected && styles.selected)}
                  data-testid={`title-${t.id}`}
                  data-tip="Title: drag to move it in time, drag the edges to change how long it shows, double-click to edit the text"
                  style={{ left: t.startMs * ppms, width: Math.max(10, t.durationMs * ppms), top: 4 + (rows.get(t.id) ?? 0) * TITLE_ROW_H, height: TITLE_ROW_H - 4 }}
                  onPointerDown={(e) => onTitleDown(e, t, "move")}
                  onPointerMove={onTitleMove}
                  onPointerUp={onTitleUp}
                  onPointerCancel={onTitleUp}
                  onDoubleClick={() => p.onEditTitle(t.id)}
                >
                  <span className={styles.titleText}>{t.text}</span>
                  <div className={cx(styles.handle, styles.handleStart)} data-tip="Drag to change when the title appears" onPointerDown={(e) => onTitleDown(e, t, "start")} />
                  <div className={cx(styles.handle, styles.handleEnd)} data-tip="Drag to change when the title disappears" onPointerDown={(e) => onTitleDown(e, t, "end")} />
                </div>
              );
            })}
            {titles.length === 0 && <div className={styles.laneEmpty}>Titles appear here</div>}
          </div>

          <div className={cx(styles.lane, styles.musicLane)} data-testid="music-lane" data-tip="Music lane: the background song under the video">
            {music ? (
              <div
                className={cx(styles.music, selection?.kind === "music" && styles.selected)}
                style={{ left: 0, width: Math.max(10, totalMs * ppms) }}
                onPointerDown={onMusicDown}
                onPointerMove={onMusicMove}
                onPointerUp={onMusicUp}
                onPointerCancel={onMusicUp}
                role="button"
                tabIndex={0}
                aria-label="Music"
                data-tip="Song: drag sideways to choose which part of it plays"
              >
                {musicPeaks.length > 0 && <Waveform peaks={musicPeaks} height={36} className={styles.wave} />}
                <span className={styles.clipLabel}>{music.path.split(/[\\/]/).pop()}</span>
              </div>
            ) : (
              <div className={styles.laneEmpty}>No song</div>
            )}
          </div>

          <div className={styles.playhead} style={{ left: Math.min(timeMs, totalMs) * ppms }} data-testid="playhead">
            {/* Drag the playhead (its head or anywhere along the line). */}
            <div className={styles.playheadGrip} data-tip="Drag to move the playhead" onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp} onPointerCancel={onRulerUp} />
          </div>
        </div>
      </div>

      {popover && popClip && popNext && (
        <>
          <div className={styles.popBackdrop} onMouseDown={() => setPopover(null)} />
          <div className={styles.pop} style={{ left: popover.x, top: popover.y }} role="dialog" aria-label="Transition" data-testid="transition-popover">
            <SegmentedControl
              aria-label="Transition"
              size="sm"
              value={(popClip.transition.kind || "cut") as "cut" | "fade" | "dip" | "slide"}
              options={TRANSITION_OPTIONS}
              onChange={(kind) => {
                if (kind !== "cut" && popLimit < MIN_TRANSITION_MS) return;
                const cur = popClip.transition.durationMs;
                p.onChange(setTransition(doc, popover.index, kind, cur >= MIN_TRANSITION_MS ? cur : Math.min(500, popLimit)));
              }}
            />
            {popClip.transition.kind !== "cut" && popLimit >= MIN_TRANSITION_MS && (
              <span data-tip="How long the transition lasts (limited by the shorter clip)" style={{ display: "contents" }}>
              <Slider
                aria-label="Transition length"
                min={MIN_TRANSITION_MS}
                max={popLimit}
                step={50}
                value={Math.min(Math.max(popClip.transition.durationMs, MIN_TRANSITION_MS), popLimit)}
                format={(v) => `${(v / 1000).toFixed(2)} s`}
                onChange={(v) => p.onChange(setTransition(doc, popover.index, popClip.transition.kind, v), `tr-${popover.index}`)}
              />
              </span>
            )}
            {popLimit < MIN_TRANSITION_MS && <div className={styles.popNote}>These clips are too short for a transition.</div>}
          </div>
        </>
      )}
    </div>
  );
}

/** Tiny glyphs for the transition chips (the shared Icon set has no fitting ones at this size). */
function chipPath(name: string): string {
  switch (name) {
    case "blend":
      return "M3 8h10M3 8l3-3M3 8l3 3M13 8l-3-3M13 8l-3 3";
    case "moon":
      return "M10 3a5 5 0 1 0 3 8 4 4 0 0 1-3-8z";
    case "arrow-right":
      return "M3 8h10M9 4l4 4-4 4";
    default:
      return "M4 4l8 8M4 12l8-8";
  }
}

