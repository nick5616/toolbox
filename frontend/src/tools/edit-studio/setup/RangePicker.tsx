/**
 * The range picker (SPEC §14.2): a full-song map (waveform, sections, beats)
 * with a draggable range whose edges snap to downbeats unless Alt is held,
 * quick picks and start/end timecodes. Controlled and presentational; exported
 * for reuse (Song inspector: "Change range…").
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, TimecodeInput } from "@/components";
import { formatMs, parseTimecodeMs } from "@/components/media/logic";
import { MediaService } from "@/lib/api";
import type { Analysis } from "@/viz/analysis";
import { barGrid } from "@/viz/edit/markers";
import type { SongRange } from "@/viz/edit/types";
import { cssColor, drawPeaks, prepCanvas } from "../lanes/draw";
import { clampRange, MAX_RANGE_MS, MIN_RANGE_MS, nearestOf, quickPicks } from "./rangeLogic";
import styles from "./Setup.module.css";

export interface RangePickerProps {
  analysis: Analysis;
  /** The song file (for the waveform). */
  songPath: string;
  value: SongRange;
  onChange: (r: SongRange) => void;
  /** The project's bar offset (downbeats the edges snap to). */
  barOffset?: number;
}

const MAP_H = 96;
const EDGE_PX = 7;

const peaksCache = new Map<string, Promise<number[]>>();
function loadPeaks(path: string): Promise<number[]> {
  let p = peaksCache.get(path);
  if (!p) {
    p = MediaService.Waveform(path, 2000).then((r) => r ?? []);
    p.catch(() => peaksCache.delete(path));
    peaksCache.set(path, p);
  }
  return p;
}

type Drag = { mode: "start" | "end" | "move" | "new"; grabMs: number; orig: SongRange };

export function RangePicker({ analysis, songPath, value, onChange, barOffset = 0 }: RangePickerProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  const [width, setWidth] = useState(0);
  const [peaks, setPeaks] = useState<number[]>([]);
  const dur = analysis.durationMs;
  const downbeats = barGrid(analysis, barOffset).starts;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let live = true;
    loadPeaks(songPath).then(
      (r) => live && setPeaks(r),
      () => live && setPeaks([]),
    );
    return () => {
      live = false;
    };
  }, [songPath]);

  const pps = dur > 0 && width > 0 ? (width * 1000) / dur : 1;
  const xOf = (ms: number) => (ms * pps) / 1000;
  const msOf = (x: number) => Math.max(0, Math.min(dur, (x * 1000) / pps));

  useEffect(() => {
    const el = cv.current;
    if (!el || width <= 0 || dur <= 0) return;
    const c = prepCanvas(el, width, MAP_H);
    if (!c) return;
    const fg = cssColor(el, "--fg", "#ededef");
    const sub = cssColor(el, "--fg-subtle", "#6b6d76");
    const accent = cssColor(el, "--accent", "#ff8c42");
    const sec = cssColor(el, "--lane-section", "#6c7a96");
    const bg = cssColor(el, "--bg-app", "#000000");
    // sections
    c.font = '10px "Geist Variable", system-ui, sans-serif';
    c.textBaseline = "top";
    analysis.audio.sections.forEach((s, i) => {
      const x0 = xOf(s.startMs);
      const x1 = xOf(s.endMs);
      c.globalAlpha = i % 2 ? 0.28 : 0.16;
      c.fillStyle = sec;
      c.fillRect(x0, 0, Math.max(1, x1 - x0), MAP_H);
      c.globalAlpha = 1;
      c.fillStyle = fg;
      if (x1 - x0 > 28) c.fillText(s.label, x0 + 4, 3, x1 - x0 - 8);
    });
    // waveform
    drawPeaks(c, peaks, { w: width, h: MAP_H - 24, pps, scrollMs: 0, songStartMs: 0, songDurationMs: dur, rangeMs: dur, color: sub });
    // bars
    if (downbeats.length > 1 && xOf(downbeats[1] as number) - xOf(downbeats[0] as number) >= 5) {
      c.fillStyle = sub;
      for (const t of downbeats) c.fillRect(Math.round(xOf(t)), MAP_H - 10, 1, 10);
    }
    // outside the range is dimmed
    c.globalAlpha = 0.6;
    c.fillStyle = bg;
    c.fillRect(0, 0, xOf(value.startMs), MAP_H);
    c.fillRect(xOf(value.endMs), 0, width - xOf(value.endMs), MAP_H);
    c.globalAlpha = 1;
    c.fillStyle = accent;
    c.fillRect(xOf(value.startMs) - 1, 0, 3, MAP_H);
    c.fillRect(xOf(value.endMs) - 2, 0, 3, MAP_H);
    c.globalAlpha = 0.9;
    c.fillRect(xOf(value.startMs), 0, Math.max(0, xOf(value.endMs) - xOf(value.startMs)), 2);
    c.fillRect(xOf(value.startMs), MAP_H - 2, Math.max(0, xOf(value.endMs) - xOf(value.startMs)), 2);
    c.globalAlpha = 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, peaks, width, value.startMs, value.endMs, dur]);

  const localX = (e: { clientX: number }) => e.clientX - (cv.current?.getBoundingClientRect().left ?? 0);

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const x = localX(e);
    const ms = msOf(x);
    let mode: Drag["mode"];
    if (Math.abs(x - xOf(value.startMs)) <= EDGE_PX) mode = "start";
    else if (Math.abs(x - xOf(value.endMs)) <= EDGE_PX) mode = "end";
    else if (ms > value.startMs && ms < value.endMs) mode = "move";
    else mode = "new";
    drag.current = { mode, grabMs: ms, orig: value };
    e.currentTarget.setPointerCapture(e.pointerId);
    if (mode === "new") {
      const s = e.altKey ? ms : nearestOf(downbeats, ms);
      onChange(clampRange({ startMs: s, endMs: s + MIN_RANGE_MS }, dur));
      drag.current = { mode: "end", grabMs: ms, orig: { startMs: s, endMs: s + MIN_RANGE_MS } };
    }
  };

  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const ms = msOf(localX(e));
    const snap = !e.altKey;
    if (d.mode === "start") {
      const s = snap ? nearestOf(downbeats, ms) : ms;
      onChange(clampRange({ startMs: Math.min(s, d.orig.endMs - MIN_RANGE_MS), endMs: d.orig.endMs }, dur));
    } else if (d.mode === "end") {
      const en = snap ? nearestOf(downbeats, ms) : ms;
      onChange(clampRange({ startMs: d.orig.startMs, endMs: Math.max(en, d.orig.startMs + MIN_RANGE_MS) }, dur));
    } else if (d.mode === "move") {
      const len = d.orig.endMs - d.orig.startMs;
      let s = d.orig.startMs + (ms - d.grabMs);
      if (snap) s = nearestOf(downbeats, s);
      s = Math.max(0, Math.min(dur - len, s));
      onChange({ startMs: Math.round(s), endMs: Math.round(s + len) });
    }
  };

  const onUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const [startText, setStartText] = useState(formatMs(value.startMs));
  const [endText, setEndText] = useState(formatMs(value.endMs));
  const [bad, setBad] = useState<"start" | "end" | null>(null);
  useEffect(() => {
    setStartText(formatMs(value.startMs));
    setEndText(formatMs(value.endMs));
    setBad(null);
  }, [value.startMs, value.endMs]);

  const commit = (which: "start" | "end") => {
    const ms = parseTimecodeMs(which === "start" ? startText : endText);
    if (ms === null) return setBad(which);
    const next = which === "start" ? { startMs: ms, endMs: Math.max(value.endMs, ms + MIN_RANGE_MS) } : { startMs: value.startMs, endMs: ms };
    const fit = clampRange(next, dur);
    if (which === "end" && ms !== fit.endMs && ms > dur) return setBad("end");
    setBad(null);
    onChange(fit);
  };

  const length = value.endMs - value.startMs;
  const picks = quickPicks(analysis, value);

  return (
    <div className={styles.picker}>
      <div ref={wrap} className={styles.map}>
        <canvas
          ref={cv}
          className={styles.mapCanvas}
          aria-label="Song range"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
      </div>
      <div className={styles.row} role="group" aria-label="Quick picks">
        {picks.map((p) => (
          <Button key={p.id} size="sm" variant="secondary" disabled={!p.range} onClick={() => p.range && onChange(p.range)}>
            {p.label}
          </Button>
        ))}
      </div>
      <div className={styles.times}>
        <label className={styles.time}>
          Start
          <TimecodeInput
            aria-label="Start"
            value={startText}
            invalid={bad === "start"}
            onChange={setStartText}
            onBlur={() => commit("start")}
            onKeyDown={(e) => e.key === "Enter" && commit("start")}
          />
        </label>
        <label className={styles.time}>
          End
          <TimecodeInput
            aria-label="End"
            value={endText}
            invalid={bad === "end"}
            onChange={setEndText}
            onBlur={() => commit("end")}
            onKeyDown={(e) => e.key === "Enter" && commit("end")}
          />
        </label>
        <span className={`${styles.length} ${length > MAX_RANGE_MS ? styles.lengthBad : ""}`} aria-label="Length">
          {formatMs(length)}
        </span>
        <span className={styles.hint}>Edges snap to bars. Hold Alt to place them freely.</span>
      </div>
    </div>
  );
}

