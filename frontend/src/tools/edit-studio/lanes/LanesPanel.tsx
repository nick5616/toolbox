/**
 * Ruler, waveform, stems and marker lanes (SPEC §14.4). One canvas per row,
 * drawn for the visible window only; scroll and zoom go through the store's
 * pps/scrollMs (virtual horizontal scroll). The playhead is a separate element
 * moved without re-rendering. T and M add custom markers, Delete hides or
 * removes the selected ones (§5.6).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Icon, MenuButton, toast } from "@/components";
import { MediaService } from "@/lib/api";
import { useShortcut } from "@/lib/shortcuts";
import { laneSettings } from "@/viz/edit/defaults";
import { TAP_LATENCY_MS } from "@/viz/edit/markers";
import { MARKER_LANES, editLength } from "@/viz/edit/types";
import { drawLane, readTheme } from "@/tools/visualizer/songmap/draw";
import { HEADER_PX, LANE_ROW_PX, msToX, RULER_PX, useTimelineWheel, xToMs } from "../geometry";
import { useEditStudio, useMarkers, useProject } from "../store";
import { cssColor, drawPeaks, prepCanvas } from "./draw";
import { LaneRow } from "./LaneRow";
import { addCustomMarker, deleteMarkers, groupByLane, LANE_LABELS, renameCustomMarker, tap, withLane, type TapState } from "./laneLogic";
import styles from "./Lanes.module.css";

const WAVE_ROW_PX = 36;
const STEM_ROW_PX = 26;
const STEMS = [
  { id: "drums", label: "Drums" },
  { id: "bass", label: "Bass" },
  { id: "vocals", label: "Vocals" },
  { id: "other", label: "Other" },
] as const;

const EMPTY_SET: ReadonlySet<string> = new Set();

/** Width of an element, tracked with a ResizeObserver. */
function useWidth(el: HTMLElement | null): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return w;
}

const peaksCache = new Map<string, Promise<number[]>>();

/** Whole-song peaks (4000 buckets), cached per file. */
function usePeaks(path: string): number[] {
  const [peaks, setPeaks] = useState<number[]>([]);
  useEffect(() => {
    if (!path) return;
    let live = true;
    let p = peaksCache.get(path);
    if (!p) {
      p = MediaService.Waveform(path, 4000).then((r) => r ?? []);
      p.catch(() => peaksCache.delete(path));
      peaksCache.set(path, p);
    }
    p.then(
      (r) => live && setPeaks(r),
      () => live && setPeaks([]),
    );
    return () => {
      live = false;
    };
  }, [path]);
  return peaks;
}

/** The playhead line, moved straight from the store (no React render per frame). */
function Playhead({ width }: { width: number }) {
  const line = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const place = () => {
      const el = line.current;
      if (!el) return;
      const s = useEditStudio.getState();
      const x = msToX(s.playheadMs, s.pps, s.scrollMs);
      el.style.display = x < 0 || x > width ? "none" : "block";
      el.style.transform = `translateX(${Math.round(x)}px)`;
    };
    place();
    return useEditStudio.subscribe(place);
  }, [width]);
  return (
    <div className={styles.playheadLayer} aria-hidden="true">
      <div ref={line} className={styles.playhead} />
    </div>
  );
}

/** Click or drag on a row seeks the playhead. */
function useSeek(durationMs: number) {
  const down = useRef(false);
  const seek = (e: ReactPointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const s = useEditStudio.getState();
    s.setPlayhead(Math.max(0, Math.min(durationMs, xToMs(e.clientX - r.left, s.pps, s.scrollMs))));
  };
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      down.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      seek(e);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      if (down.current) seek(e);
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      down.current = false;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    },
  };
}

export function LanesPanel() {
  const project = useProject();
  const analysis = useEditStudio((s) => s.analysis);
  const markers = useMarkers();
  const pps = useEditStudio((s) => s.pps);
  const scrollMs = useEditStudio((s) => s.scrollMs);
  const activeLane = useEditStudio((s) => s.activeLane);
  const selection = useEditStudio((s) => s.selection);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(180);
  const [stemsOpen, setStemsOpen] = useState(false);
  const [rename, setRename] = useState<{ id: string; value: string; left: number; top: number } | null>(null);
  const tapState = useRef<TapState>({ lastAt: -Infinity });
  // The shortcut handlers and the rename input read the freshest values through refs.
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const renameRef = useRef<typeof rename>(null);
  const duration = project ? editLength(project) : 0;
  const width = Math.max(0, useWidth(el) - HEADER_PX);
  useTimelineWheel(el, duration);
  const seek = useSeek(duration);
  const peaks = usePeaks(project?.song?.path ?? "");

  const byLane = useMemo(() => groupByLane(markers), [markers]);
  const selected = useMemo<ReadonlySet<string>>(() => (selection?.kind === "markers" ? new Set(selection.ids) : EMPTY_SET), [selection]);

  // ---- shortcuts (§5.6) ----
  const ready = !!project?.song && !!analysis;
  useShortcut(
    "t",
    (e) => {
      if (e.repeat) return;
      const s = useEditStudio.getState();
      const p = s.history?.present;
      if (!p?.song || !s.playing) return;
      const r = tap(p, tapState.current, performance.now(), p.song.startMs + s.playheadMs - TAP_LATENCY_MS);
      if (r.kind === "added" || r.kind === "deleted") s.edit(r.project);
      else if (r.kind === "full") toast({ title: "That's the most custom markers (2,000)", tone: "warn" });
    },
    { when: ready },
  );
  useShortcut(
    "m",
    (e) => {
      if (e.repeat) return;
      const s = useEditStudio.getState();
      const p = s.history?.present;
      if (!p?.song || s.playing) return;
      const added = addCustomMarker(p, p.song.startMs + s.playheadMs);
      if (!added) {
        if (p.markers.custom.length >= 2000) toast({ title: "That's the most custom markers (2,000)", tone: "warn" });
        return;
      }
      s.edit(added.project);
      s.select({ kind: "markers", ids: [added.id] });
    },
    { when: ready },
  );
  useShortcut(
    ["Delete", "Backspace"],
    () => {
      const s = useEditStudio.getState();
      const p = s.history?.present;
      if (!p || s.selection?.kind !== "markers") return;
      const ids = new Set(s.selection.ids);
      const list = markersRef.current.filter((m) => ids.has(m.id));
      const r = deleteMarkers(p, list);
      if (r.project !== p) s.edit(r.project);
      if (r.full) toast({ title: "Too many hidden markers", description: "Use Reset lane in a lane's settings to bring some back.", tone: "warn" });
      s.select(null);
    },
    { when: ready && selection?.kind === "markers" },
  );

  const startRename = useCallback((id: string, label: string, at: { left: number; top: number }) => {
    const r = { id, value: label, ...at };
    renameRef.current = r;
    setRename(r);
  }, []);
  const commitRename = () => {
    const r = renameRef.current;
    renameRef.current = null;
    setRename(null);
    if (!r) return;
    const p = useEditStudio.getState().history?.present;
    if (p) useEditStudio.getState().edit(renameCustomMarker(p, r.id, r.value));
  };

  // ---- resize ----
  const resize = useRef<{ y: number; h: number } | null>(null);

  if (!project || !project.song || !analysis) return null;
  const song = project.song;
  const lanes = MARKER_LANES.filter((l) => laneSettings(project.markers, l).visible);
  const hiddenLanes = MARKER_LANES.filter((l) => !laneSettings(project.markers, l).visible);
  const hasStems = analysis.audio.stems;

  return (
    <div ref={setEl} className={styles.root} style={{ height }} aria-label="Lanes">
      <div className={styles.scroll} role="radiogroup" aria-label="Active lane">
        <RulerRow width={width} pps={pps} scrollMs={scrollMs} hiddenLanes={hiddenLanes} seek={seek} />
        <WaveRow width={width} pps={pps} scrollMs={scrollMs} peaks={peaks} songStartMs={song.startMs} songDurationMs={analysis.durationMs} rangeMs={duration} seek={seek} />
        {hasStems && (
          <>
            <div className={styles.row} style={{ height: LANE_ROW_PX }}>
              <div className={styles.header}>
                <button type="button" className={styles.iconBtn} aria-expanded={stemsOpen} aria-label={stemsOpen ? "Collapse instruments" : "Expand instruments"} onClick={() => setStemsOpen(!stemsOpen)}>
                  <Icon name={stemsOpen ? "chevron-down" : "chevron-right"} size={12} />
                </button>
                <span className={styles.name}>Instruments</span>
              </div>
              <div className={styles.area} />
            </div>
            {stemsOpen && STEMS.map((s) => <StemRow key={s.id} stem={s.id} label={s.label} width={width} pps={pps} scrollMs={scrollMs} songStartMs={song.startMs} />)}
          </>
        )}
        {lanes.map((lane) => (
          <LaneRow
            key={lane}
            lane={lane}
            settings={laneSettings(project.markers, lane)}
            markers={byLane.get(lane) ?? NO_MARKERS}
            active={activeLane === lane}
            selected={selected}
            pps={pps}
            scrollMs={scrollMs}
            width={width}
            analysis={analysis}
            songStartMs={song.startMs}
            songEndMs={song.endMs}
            barOffset={project.markers.barOffset}
            onRename={(m, at) => startRename(m.id, m.label ?? "", at)}
          />
        ))}
      </div>
      <div
        className={styles.resizer}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize lanes"
        onPointerDown={(e) => {
          resize.current = { y: e.clientY, h: height };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const r = resize.current;
          if (r) setHeight(Math.max(80, Math.min(520, r.h + e.clientY - r.y)));
        }}
        onPointerUp={(e) => {
          resize.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        }}
      />
      <Playhead width={width} />
      {rename && (
        <input
          className={styles.renameInput}
          style={{ left: rename.left, top: rename.top }}
          autoFocus
          maxLength={40}
          aria-label="Marker name"
          value={rename.value}
          onChange={(e) => {
            const r = { ...rename, value: e.target.value };
            renameRef.current = r;
            setRename(r);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            else if (e.key === "Escape") {
              renameRef.current = null;
              setRename(null);
            }
            e.stopPropagation();
          }}
          onBlur={commitRename}
        />
      )}
    </div>
  );
}

const NO_MARKERS: never[] = [];

interface RowCommon {
  width: number;
  pps: number;
  scrollMs: number;
}

function RulerRow({ width, pps, scrollMs, hiddenLanes, seek }: RowCommon & { hiddenLanes: readonly (typeof MARKER_LANES)[number][]; seek: ReturnType<typeof useSeek> }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const analysis = useEditStudio((s) => s.analysis);
  useEffect(() => {
    const el = cv.current;
    if (!el || !analysis || width <= 0) return;
    const c = prepCanvas(el, width, RULER_PX);
    if (!c) return;
    drawLane(c, "ruler", analysis, { startMs: scrollMs, endMs: scrollMs + (width * 1000) / pps, width }, pps, width, RULER_PX, readTheme(el));
  }, [analysis, width, pps, scrollMs]);
  return (
    <div className={styles.row} style={{ height: RULER_PX }}>
      <div className={styles.header}>
        <span className={styles.name}>Lanes</span>
        <MenuButton
          label="Show more lanes"
          icon="plus"
          variant="ghost"
          size="sm"
          emptyLabel="Every lane is shown"
          items={() =>
            hiddenLanes.map((l) => ({
              id: l,
              label: LANE_LABELS[l],
              onSelect: () => {
                const p = useEditStudio.getState().history?.present;
                if (p) useEditStudio.getState().edit(withLane(p, l, { visible: true }));
              },
            }))
          }
        />
      </div>
      <div className={styles.area}>
        <canvas ref={cv} className={`${styles.canvas} ${styles.ruler}`} aria-label="Ruler" {...seek} />
      </div>
    </div>
  );
}

function WaveRow(props: RowCommon & { peaks: number[]; songStartMs: number; songDurationMs: number; rangeMs: number; seek: ReturnType<typeof useSeek> }) {
  const { width, pps, scrollMs, peaks, songStartMs, songDurationMs, rangeMs, seek } = props;
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = cv.current;
    if (!el || width <= 0) return;
    const c = prepCanvas(el, width, WAVE_ROW_PX);
    if (!c) return;
    drawPeaks(c, peaks, { w: width, h: WAVE_ROW_PX, pps, scrollMs, songStartMs, songDurationMs, rangeMs, color: cssColor(el, "--fg-subtle", "#6b6d76") });
  }, [peaks, width, pps, scrollMs, songStartMs, songDurationMs, rangeMs]);
  return (
    <div className={styles.row} style={{ height: WAVE_ROW_PX }}>
      <div className={styles.header}>
        <Icon name="audio-waveform" size={12} />
        <span className={styles.name}>Song</span>
      </div>
      <div className={styles.area}>
        <canvas ref={cv} className={`${styles.canvas} ${styles.wave}`} aria-label="Song waveform" {...seek} />
      </div>
    </div>
  );
}

function StemRow({ stem, label, width, pps, scrollMs, songStartMs }: RowCommon & { stem: (typeof STEMS)[number]["id"]; label: string; songStartMs: number }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const analysis = useEditStudio((s) => s.analysis);
  useEffect(() => {
    const el = cv.current;
    if (!el || !analysis || width <= 0) return;
    const c = prepCanvas(el, width, STEM_ROW_PX);
    if (!c) return;
    const startMs = songStartMs + scrollMs;
    drawLane(c, stem, analysis, { startMs, endMs: startMs + (width * 1000) / pps, width }, pps, width, STEM_ROW_PX, readTheme(el));
  }, [analysis, stem, width, pps, scrollMs, songStartMs]);
  return (
    <div className={styles.row} style={{ height: STEM_ROW_PX }}>
      <div className={styles.header}>
        <span className={styles.name}>{label}</span>
      </div>
      <div className={styles.area}>
        <canvas ref={cv} className={styles.canvas} aria-label={`${label} level`} />
      </div>
    </div>
  );
}
