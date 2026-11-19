/**
 * The ruler (Phase 21 SPEC §B2): on top of the tracks in both editors, above
 * Edit Studio's lanes. Adaptive timecode ticks; a click seeks and a drag
 * scrubs; marker flags (Video Editor only: Edit Studio's lanes own its
 * markers); the In/Out range shaded.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Icon, cx } from "@/components";
import { useElementSize } from "@/lib/useElementSize";
import { editLength } from "@/viz/edit/types";
import { HEADER_PX, msToX, useTimelineWheel } from "@/editor/geometry";
import { useEditStudio, useProject } from "@/editor/store";
import { useEditorProfile } from "../profileContext";
import { seekTo } from "../transport/player";
import { collapseDrag, commit } from "./actions";
import { moveRulerMarker, renameRulerMarker, rulerMarkers } from "./markers";
import { rulerTicks } from "./rulerTicks";
import { timelineRoomMs } from "./songFile";
import { startScrub } from "./scrub";
import { useTimelineStore } from "./timelineStore";
import styles from "./Ruler.module.css";

/** Height of the ruler row. */
export const TIME_RULER_PX = 26;
let dragSeq = 0;

export function Ruler() {
  const project = useProject();
  if (!project) return null;
  return <RulerRow />;
}

function RulerRow() {
  const project = useProject() as NonNullable<ReturnType<typeof useProject>>;
  const profile = useEditorProfile();
  const pps = useEditStudio((s) => s.pps);
  const scrollMs = useEditStudio((s) => s.scrollMs);
  const playheadMs = useEditStudio((s) => s.playheadMs);
  const rangeIn = useTimelineStore((s) => s.rangeInMs);
  const rangeOut = useTimelineStore((s) => s.rangeOutMs);
  const loop = useTimelineStore((s) => s.loop);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const { width } = useElementSize(root);
  const timeWidth = Math.max(0, width - HEADER_PX);
  useTimelineWheel(root, timelineRoomMs(project));
  const setViewWidth = useTimelineStore((s) => s.setViewWidth);
  useEffect(() => {
    if (timeWidth > 0) setViewWidth(timeWidth);
  }, [timeWidth, setViewWidth]);

  const D = editLength(project);
  const ticks = useMemo(() => rulerTicks(pps, scrollMs, timeWidth, project.fps), [pps, scrollMs, timeWidth, project.fps]);
  const showFlags = profile.song === "optional";
  const markers = useMemo(() => (showFlags ? rulerMarkers(project) : []), [showFlags, project]);
  const [editing, setEditing] = useState<string | null>(null);
  const timeLeft = (): number => (root?.getBoundingClientRect().left ?? 0) + HEADER_PX;

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("[data-flag],input")) return;
    // Past the end of the edit the playhead still goes there (the clips may run past it).
    startScrub(e, timeLeft, Math.max(D, useEditStudio.getState().scrollMs + (timeWidth * 1000) / Math.max(1, pps)));
  };

  const range = rangeIn !== null && rangeOut !== null ? { x0: msToX(rangeIn, pps, scrollMs), x1: msToX(rangeOut, pps, scrollMs) } : null;
  const playX = msToX(playheadMs, pps, scrollMs);

  return (
    <div ref={setRoot} className={styles.ruler} style={{ height: TIME_RULER_PX }} data-timeline-ruler>
      <div className={styles.header}>
        {range && (
          <span className={styles.rangeLabel} data-tip={`The In–Out range: export can use just this part${loop ? "; looping while you play" : " (Shift+L loops it)"}. Alt+X clears it`}>
            <Icon name={loop ? "repeat" : "square-dashed"} size={12} />
            {formatSpan((rangeOut as number) - (rangeIn as number))}
          </span>
        )}
      </div>
      <div className={styles.time} onPointerDown={onDown} aria-label="Ruler: click or drag to move the playhead" role="slider" aria-valuemin={0} aria-valuemax={Math.round(D)} aria-valuenow={Math.round(playheadMs)} tabIndex={-1} data-tip="Click or drag to move the playhead">
        {range && (
          <div
            className={styles.range}
            style={{ left: Math.max(0, range.x0), width: Math.max(0, Math.min(timeWidth, range.x1) - Math.max(0, range.x0)) }}
            data-range
            aria-hidden="true"
          />
        )}
        {ticks.map((t) => {
          const x = msToX(t.ms, pps, scrollMs);
          return t.major ? (
            <span key={t.ms} className={styles.major} style={{ left: x }} data-tick="major">
              <span className={styles.label}>{t.label}</span>
            </span>
          ) : (
            <span key={t.ms} className={styles.minor} style={{ left: x }} data-tick="minor" />
          );
        })}
        {rangeIn !== null && rangeIn >= scrollMs && <span className={styles.bracket} style={{ left: msToX(rangeIn, pps, scrollMs) }} data-tip="Range start (I)">[</span>}
        {rangeOut !== null && rangeOut >= scrollMs && <span className={cx(styles.bracket, styles.bracketEnd)} style={{ left: msToX(rangeOut, pps, scrollMs) }} data-tip="Range end (O)">]</span>}
        {markers.map((m) => {
          const x = msToX(m.ms, pps, scrollMs);
          if (x < -4 || x > timeWidth + 4) return null;
          return (
            <MarkerFlag
              key={m.id}
              id={m.id}
              x={x}
              label={m.label}
              editing={editing === m.id}
              onEdit={setEditing}
            />
          );
        })}
        {playX >= -6 && playX <= timeWidth + 6 && <span className={styles.playhead} style={{ left: playX }} aria-hidden="true" data-ruler-playhead />}
      </div>
    </div>
  );
}


/** "1:23.4" style length of a range. */
function formatSpan(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}` : `${s.toFixed(1)}s`;
}

interface FlagProps {
  id: string;
  x: number;
  label: string;
  editing: boolean;
  onEdit(id: string | null): void;
}

function MarkerFlag({ id, x, label, editing, onEdit }: FlagProps) {
  const selected = useEditStudio((s) => s.selection?.kind === "markers" && s.selection.ids.includes(id));
  const [draft, setDraft] = useState(label);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      setDraft(label);
      input.current?.select();
    }
  }, [editing, label]);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || editing) return;
    e.stopPropagation();
    const st = useEditStudio.getState();
    const base = st.history?.present;
    if (!base) return;
    st.select({ kind: "markers", ids: [id] });
    const startX = e.clientX;
    const startMs = rulerMarkers(base).find((m) => m.id === id)?.ms ?? 0;
    const key = `marker-${++dragSeq}`;
    const startPast = st.history?.past.length ?? 0;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < 3) return;
      moved = true;
      const now = useEditStudio.getState();
      const ms = Math.max(0, startMs + ((ev.clientX - startX) * 1000) / now.pps);
      const next = moveRulerMarker(base, id, ms);
      if (next) now.edit(next, key);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      collapseDrag(startPast, base);
      // A click (no drag) puts the playhead on the marker.
      if (!moved && ev.type === "pointerup") seekTo(startMs);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const save = (keep: boolean) => {
    onEdit(null);
    if (!keep) return;
    const doc = useEditStudio.getState().history?.present;
    if (doc) commit(renameRulerMarker(doc, id, draft));
  };

  return (
    <div
      className={cx(styles.flag, selected && styles.flagSelected)}
      style={{ left: x }}
      data-flag={id}
      role="button"
      tabIndex={-1}
      aria-label={label ? `Marker ${label}` : "Marker"}
      aria-pressed={selected}
      data-tip={`${label || "Marker"}: click to go there, drag to move, double-click to name it, Delete removes it`}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onEdit(id);
      }}
    >
      <Icon name="flag" size={11} />
      {editing ? (
        <input
          ref={input}
          className={styles.flagInput}
          aria-label="Marker name"
          data-tip="Marker name (up to 40 characters); Enter saves, Esc cancels"
          value={draft}
          maxLength={40}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => save(true)}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") save(true);
            if (e.key === "Escape") save(false);
          }}
        />
      ) : (
        label && <span className={styles.flagLabel}>{label}</span>
      )}
    </div>
  );
}
