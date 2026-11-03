/** One marker lane row (§14.4): header (swatch, name, count, eye, ⋯) and a canvas for the visible window. */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "@/components";
import { formatMs } from "@/components/media/logic";
import type { Analysis } from "@/viz/analysis";
import type { LaneSettings, Marker, MarkerLane } from "@/viz/edit/types";
import { LANE_ROW_PX, xToMs } from "../geometry";
import { useEditStudio } from "../store";
import { cssColor, drawMarkerLane, laneColor, prepCanvas } from "./draw";
import {
  addCustomMarker,
  describeMarker,
  hitTest,
  LANE_LABELS,
  moveMarker,
  snapSongMs,
  withLane,
} from "./laneLogic";
import { LaneSettingsPopover } from "./LaneSettingsPopover";
import styles from "./Lanes.module.css";
import { startScrub } from "../timeline/scrub";
import { seekTo } from "../transport/player";
import { editLength } from "@/viz/edit/types";

export interface LaneRowProps {
  lane: MarkerLane;
  settings: LaneSettings;
  markers: readonly Marker[];
  active: boolean;
  selected: ReadonlySet<string>;
  pps: number;
  scrollMs: number;
  /** Width of the time area in px. */
  width: number;
  analysis: Analysis;
  songStartMs: number;
  songEndMs: number;
  barOffset: number;
  onRename: (marker: Marker, at: { left: number; top: number }) => void;
}

interface DragState {
  marker: Marker;
  startX: number;
  active: boolean;
  target: number;
}

export function LaneRow(props: LaneRowProps) {
  const { lane, settings, markers, active, selected, pps, scrollMs, width, analysis, songStartMs, songEndMs, barOffset } = props;
  const cv = useRef<HTMLCanvasElement>(null);
  const drag = useRef<DragState | null>(null);
  const [preview, setPreview] = useState<{ id: string; deltaMs: number } | null>(null);
  const [hover, setHover] = useState<{ marker: Marker; x: number; y: number } | null>(null);
  const [pop, setPop] = useState<DOMRect | null>(null);

  useEffect(() => {
    const el = cv.current;
    if (!el || width <= 0) return;
    const c = prepCanvas(el, width, LANE_ROW_PX);
    if (!c) return;
    drawMarkerLane(c, {
      markers,
      w: width,
      h: LANE_ROW_PX,
      pps,
      scrollMs,
      color: laneColor(el, lane),
      textColor: cssColor(el, "--fg", "#ededef"),
      selectColor: cssColor(el, "--fg", "#ededef"),
      selected,
      drag: preview,
    });
  }, [markers, width, pps, scrollMs, selected, preview, lane]);

  const localX = (e: { clientX: number }) => e.clientX - (cv.current?.getBoundingClientRect().left ?? 0);

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const x = localX(e);
    const hit = hitTest(markers, x, pps, scrollMs);
    const st = useEditStudio.getState();
    const cur = st.selection?.kind === "markers" ? st.selection.ids : [];
    if (!hit) {
      if (st.selection?.kind === "markers") st.select(null);
      // Empty lane space works like the ruler: click or drag moves the playhead.
      const el = e.currentTarget;
      const p = st.history?.present;
      startScrub(e, () => el.getBoundingClientRect().left, p ? editLength(p) : 0);
      return;
    }
    if (e.shiftKey) st.select({ kind: "markers", ids: cur.includes(hit.id) ? cur.filter((i) => i !== hit.id) : [...cur, hit.id] });
    else if (!cur.includes(hit.id)) st.select({ kind: "markers", ids: [hit.id] });
    drag.current = { marker: hit, startX: x, active: false, target: songStartMs + hit.ms };
    setHover(null);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const x = localX(e);
    const d = drag.current;
    if (d) {
      if (!d.active && Math.abs(x - d.startX) > 3) d.active = true;
      if (!d.active) return;
      const raw = songStartMs + d.marker.ms + (xToMs(x, pps, scrollMs) - xToMs(d.startX, pps, scrollMs));
      const clamped = Math.max(songStartMs, Math.min(songEndMs - 1, raw));
      const snapped = Math.max(songStartMs, Math.min(songEndMs - 1, snapSongMs(analysis, clamped, !e.altKey)));
      d.target = snapped;
      setPreview({ id: d.marker.id, deltaMs: snapped - (songStartMs + d.marker.ms) });
      return;
    }
    const hit = hitTest(markers, x, pps, scrollMs);
    setHover((h) => (hit ? (h && h.marker === hit ? h : { marker: hit, x: e.clientX, y: e.clientY }) : null));
  };

  const finish = (e: ReactPointerEvent<HTMLCanvasElement>, commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    setPreview(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    // A click on a marker (no drag) moves the playhead to it.
    if (d && !d.active && commit) seekTo(d.marker.ms);
    if (!d || !d.active || !commit) return;
    const p = useEditStudio.getState().history?.present;
    if (p) useEditStudio.getState().edit(moveMarker(p, d.marker, d.target));
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const x = localX(e);
    const hit = hitTest(markers, x, pps, scrollMs);
    if (lane !== "custom") return;
    if (hit) {
      props.onRename(hit, { left: e.clientX - 20, top: e.clientY + 8 });
      return;
    }
    const p = useEditStudio.getState().history?.present;
    if (!p) return;
    const added = addCustomMarker(p, songStartMs + xToMs(x, pps, scrollMs));
    if (added) {
      useEditStudio.getState().edit(added.project);
      useEditStudio.getState().select({ kind: "markers", ids: [added.id] });
    }
  };

  const toggleVisible = () => {
    const p = useEditStudio.getState().history?.present;
    if (p) useEditStudio.getState().edit(withLane(p, lane, { visible: !settings.visible }));
  };

  return (
    <div className={styles.row} style={{ height: LANE_ROW_PX }}>
      <div
        className={styles.header}
        role="radio"
        aria-checked={active}
        aria-label={`${LANE_LABELS[lane]} lane`}
        tabIndex={0}
        onClick={() => useEditStudio.getState().setActiveLane(lane)}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            useEditStudio.getState().setActiveLane(lane);
          }
        }}
      >
        <span className={styles.swatch} style={{ background: `var(--lane-${lane})` }} />
        <span className={styles.name}>{LANE_LABELS[lane]}</span>
        {lane === "downbeat" && barOffset > 0 && <span className={styles.hint} title="Bar starts on beat">{`bar = beat ${barOffset + 1}`}</span>}
        <span className={styles.count} aria-label={`${markers.length} markers`}>
          {markers.length}
        </span>
        <button
          type="button"
          className={styles.iconBtn}
          aria-label={`Hide ${LANE_LABELS[lane]}`}
          title="Hide lane"
          onClick={(e) => {
            e.stopPropagation();
            toggleVisible();
          }}
        >
          <Icon name="eye" size={12} />
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          aria-label={`${LANE_LABELS[lane]} settings`}
          aria-haspopup="dialog"
          data-pop-anchor="1"
          aria-expanded={pop !== null}
          onClick={(e) => {
            e.stopPropagation();
            setPop(pop ? null : e.currentTarget.getBoundingClientRect());
          }}
        >
          <Icon name="ellipsis" size={12} />
        </button>
      </div>
      <div className={styles.area}>
        <canvas
          ref={cv}
          className={styles.canvas}
          aria-label={`${LANE_LABELS[lane]} markers`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => finish(e, true)}
          onPointerCancel={(e) => finish(e, false)}
          onPointerLeave={() => setHover(null)}
          onDoubleClick={onDoubleClick}
        />
      </div>
      {hover && (
        <div className={styles.tooltip} style={{ left: hover.x + 12, top: hover.y + 14 }} role="tooltip">
          {describeMarker(hover.marker, formatMs)}
        </div>
      )}
      {pop && <LaneSettingsPopover lane={lane} count={markers.length} anchor={pop} stems={analysis.audio.stems} onClose={() => setPop(null)} />}
    </div>
  );
}
