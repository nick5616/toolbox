/**
 * Tracks, clips, snapping and the song track (Phase 9 SPEC §14.5). DOM rows
 * (a header column, then the time area on the shared pps/scrollMs), pointer
 * drags that record one undo step each, a marquee, context menus and drops
 * from the Sources panel.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Button, ConfirmDialog, cx, toast } from "@/components";
import { LibraryService, type EditClip } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import type { NormalProject } from "@/viz/edit/defaults";
import { editLength } from "@/viz/edit/types";
import { HEADER_PX, msToX, useTimelinePan, useTimelineWheel, xToMs } from "../geometry";
import { dragWantsSourceLength, useSourceDropTarget, type SourceDropInfo } from "../sources/dragSource";
import { useEditStudio, useMarkers, useProject } from "../store";
import { seekTo } from "../transport/player";
import { collapseDrag, commit, selectedClipIds, sliceSelection, splitAtPlayhead, splitSubjectOfSelection, insertSources, deleteSelection, duplicateSelection } from "./actions";
import { clipStatus } from "./clipInfo";
import { ClipView, type MatteBadge } from "./ClipView";
import { ContextMenu, type ContextItem } from "./ContextMenu";
import { addTrack, insertAdjustClip, laneMarkersMs, moveClips, removeTrack, renameTrack, reorderTrack, setTrackKind, setTrackLocked, setTrackMuted, trimClip } from "./ops";
import { buildSnapTargets, snapPoint, snapSpan } from "./snapping";
import { SongTrack } from "./SongTrack";
import { TrackHeader } from "./TrackHeader";
import { withClip } from "../doc";
import styles from "./TracksPanel.module.css";
import { TimeScrollbar } from "./TimeScrollbar";
import { addTextClip } from "../text/addText";
import { addVisualClip } from "../visual/addVisual";

export const VIDEO_ROW_PX = 56;
export const ADJUST_ROW_PX = 36;
const DRAG_PX = 4;
let dragSeq = 0;

interface Hint {
  ms: number;
  label: string;
}

interface Menu {
  x: number;
  y: number;
}

function Playhead() {
  const ms = useEditStudio((s) => s.playheadMs);
  const pps = useEditStudio((s) => s.pps);
  const scrollMs = useEditStudio((s) => s.scrollMs);
  const x = msToX(ms, pps, scrollMs);
  if (x < -1) return null;
  return <div className={styles.playhead} style={{ left: HEADER_PX + x }} aria-hidden="true" />;
}

export function TracksPanel() {
  const project = useProject();
  if (!project) return null;
  return <Tracks project={project} />;
}

function Tracks({ project }: { project: NormalProject }) {
  const pps = useEditStudio((s) => s.pps);
  const scrollMs = useEditStudio((s) => s.scrollMs);
  const selection = useEditStudio((s) => s.selection);
  const sources = useEditStudio((s) => s.sources);
  const mattes = useEditStudio((s) => s.mattes);
  const markers = useMarkers();
  const D = editLength(project);

  const rootRef = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [hint, setHint] = useState<Hint | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useLayoutEffect(() => setRoot(rootRef.current), []);
  useEffect(() => {
    if (!root) return;
    const measure = () => setWidth(root.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [root]);
  useTimelineWheel(root, D);
  useTimelinePan(root, D);

  const timeWidth = Math.max(0, width - HEADER_PX);

  // While playing, keep the playhead in view: when it leaves the right 8 %,
  // page forward so it sits 10 % in from the left (lanes follow the same scroll).
  useEffect(() => {
    if (timeWidth <= 0) return;
    return useEditStudio.subscribe((s, prev) => {
      if (!s.playing || s.playheadMs === prev.playheadMs) return;
      const visible = (timeWidth * 1000) / s.pps;
      const t = s.playheadMs;
      if (t >= s.scrollMs && t <= s.scrollMs + visible * 0.92) return;
      const maxScroll = Math.max(0, live.current.D - visible);
      s.setView(s.pps, Math.min(maxScroll, Math.max(0, t - visible * 0.1)));
    });
  }, [timeWidth]);
  const selected = useMemo(() => new Set(selection?.kind === "clips" ? selection.ids : []), [selection]);
  const selectedTrack = selection?.kind === "track" ? selection.id : null;

  const live = useRef({ project, markers, sources, D });
  live.current = { project, markers, sources, D };

  // ---- geometry helpers ----
  const rowAt = (clientY: number): string | null => {
    const rows = rootRef.current?.querySelectorAll<HTMLElement>("[data-track-row]") ?? [];
    for (const r of rows) {
      const b = r.getBoundingClientRect();
      if (clientY >= b.top && clientY < b.bottom) return r.dataset.trackRow ?? null;
    }
    return null;
  };
  const msAtX = (clientX: number): number => {
    const r = rootRef.current?.getBoundingClientRect();
    const st = useEditStudio.getState();
    return xToMs(clientX - (r?.left ?? 0) - HEADER_PX, st.pps, st.scrollMs);
  };

  // ---- dragging a clip ----
  const onClipPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>, clip: EditClip) => {
    if (e.button !== 0) return;
    const st = useEditStudio.getState();
    const base = st.history?.present;
    if (!base) return;
    const cur = selectedClipIds(st.selection);
    const additive = e.shiftKey;
    const toggle = e.ctrlKey || e.metaKey;
    let ids: string[];
    if (additive) ids = cur.includes(clip.id) ? cur : [...cur, clip.id];
    else if (toggle) ids = cur.includes(clip.id) ? cur.filter((x) => x !== clip.id) : [...cur, clip.id];
    else ids = cur.includes(clip.id) ? cur : [clip.id];
    st.select(ids.length ? { kind: "clips", ids } : null);
    if (additive || toggle || !ids.includes(clip.id)) return;
    const home = base.tracks.find((t) => t.clips.some((c) => c.id === clip.id));
    if (!home || home.locked) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const key = `move-${++dragSeq}`;
    const startPast = st.history?.past.length ?? 0;
    const targets = buildSnapTargets({ project: base, markers: live.current.markers, playheadMs: st.playheadMs, exclude: new Set(ids) });
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_PX) return;
      moved = true;
      const now = useEditStudio.getState();
      let delta = ((ev.clientX - startX) * 1000) / now.pps;
      if (now.snap && !ev.altKey) {
        const s = snapSpan(clip.startMs + delta, clip.endMs + delta, targets, now.pps);
        delta += s.deltaMs;
        setHint(s.target ? { ms: s.target.ms, label: s.target.label } : null);
      } else setHint(null);
      const next = moveClips(base, ids, Math.round(delta), rowAt(ev.clientY) ?? undefined);
      if (next) now.edit(next, key);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setHint(null);
      collapseDrag(startPast, base);
      if (!moved && ids.length > 1) useEditStudio.getState().select({ kind: "clips", ids: [clip.id] });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads live state
  }, []);

  // ---- trimming ----
  const onTrimDown = useCallback((e: ReactPointerEvent<HTMLElement>, clip: EditClip, edge: "start" | "end") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const st = useEditStudio.getState();
    const base = st.history?.present;
    if (!base) return;
    const home = base.tracks.find((t) => t.clips.some((c) => c.id === clip.id));
    if (!home || home.locked) return;
    st.select({ kind: "clips", ids: [clip.id] });
    const startX = e.clientX;
    const key = `trim-${++dragSeq}`;
    const startPast = st.history?.past.length ?? 0;
    const from = edge === "start" ? clip.startMs : clip.endMs;
    const sourceMs = live.current.sources[clip.path]?.info.durationMs ?? 0;
    const targets = buildSnapTargets({ project: base, markers: live.current.markers, playheadMs: st.playheadMs, exclude: new Set([clip.id]) });
    const onMove = (ev: PointerEvent) => {
      const now = useEditStudio.getState();
      let to = from + ((ev.clientX - startX) * 1000) / now.pps;
      if (now.snap && !ev.altKey) {
        const s = snapPoint(to, targets, now.pps);
        if (s) to = s.ms;
        setHint(s ? { ms: s.ms, label: s.label } : null);
      } else setHint(null);
      const next = trimClip(base, clip.id, edge, Math.round(to), { sourceMs });
      if (next) now.edit(next, key);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setHint(null);
      collapseDrag(startPast, base);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, []);

  // ---- empty space: click (select track + seek) or marquee ----
  const onAreaPointerDown = (e: ReactPointerEvent<HTMLDivElement>, trackId: string) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const additive = e.shiftKey;
    const before = selectedClipIds(useEditStudio.getState().selection);
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_PX) return;
      moved = true;
      setMarquee({ x0: startX - rect.left, y0: startY - rect.top, x1: ev.clientX - rect.left, y1: ev.clientY - rect.top });
      const a = msAtX(Math.min(startX, ev.clientX));
      const b = msAtX(Math.max(startX, ev.clientX));
      const top = Math.min(startY, ev.clientY);
      const bottom = Math.max(startY, ev.clientY);
      const ids = new Set(additive ? before : []);
      for (const row of rootRef.current?.querySelectorAll<HTMLElement>("[data-track-row]") ?? []) {
        const rb = row.getBoundingClientRect();
        if (rb.bottom < top || rb.top > bottom) continue;
        const t = live.current.project.tracks.find((x) => x.id === row.dataset.trackRow);
        for (const c of t?.clips ?? []) if (c.startMs < b && c.endMs > a) ids.add(c.id);
      }
      useEditStudio.getState().select(ids.size ? { kind: "clips", ids: [...ids] } : null);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setMarquee(null);
      if (!moved && ev.type === "pointerup") {
        useEditStudio.getState().select({ kind: "track", id: trackId });
        seekTo(Math.max(0, Math.min(live.current.D, msAtX(ev.clientX))));
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onAreaDoubleClick = (e: ReactMouseEvent<HTMLDivElement>, trackId: string) => {
    if (e.target !== e.currentTarget) return;
    const doc = live.current.project;
    const track = doc.tracks.find((t) => t.id === trackId);
    if (track?.kind !== "adjust") return;
    const st = useEditStudio.getState();
    const ins = insertAdjustClip(doc, trackId, msAtX(e.clientX), { markersMs: laneMarkersMs(live.current.markers, st.activeLane) });
    if (ins && commit(ins.project)) st.select({ kind: "clips", ids: [ins.clip.id] });
  };

  // ---- drops from the Sources panel ----
  const onDrop = useCallback((info: SourceDropInfo) => {
    const doc = live.current.project;
    const trackId = rowAt(info.y);
    const track = doc.tracks.find((t) => t.id === trackId);
    if (!track || track.kind !== "video" || track.locked) {
      toast({ title: "Drop sources on an unlocked video track", tone: "warn" });
      return;
    }
    insertSources(info.paths, track.id, Math.max(0, msAtX(info.x)), dragWantsSourceLength() ? "source" : "fill-next", live.current.markers);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads live state
  }, []);
  useSourceDropTarget(rootRef, onDrop);

  // ---- context menu ----
  const onClipContextMenu = useCallback((e: ReactMouseEvent<HTMLDivElement>, clip: EditClip) => {
    e.preventDefault();
    const st = useEditStudio.getState();
    if (!selectedClipIds(st.selection).includes(clip.id)) st.select({ kind: "clips", ids: [clip.id] });
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  const menuItems = (): ContextItem[] => {
    const st = useEditStudio.getState();
    const doc = st.history?.present;
    const ids = selectedClipIds(st.selection);
    if (!doc || !ids.length) return [];
    const clips = doc.tracks.flatMap((t) => t.clips).filter((c) => ids.includes(c.id));
    const underPlayhead = clips.some((c) => c.startMs < st.playheadMs && st.playheadMs < c.endMs);
    const allPinned = clips.length > 0 && clips.every((c) => c.pinned);
    const one = clips.length === 1 ? (clips[0] as EditClip) : null;
    const hasMatte = !!one?.matte && !!mattes[one.matte.id]?.ready;
    const file = one && (one.kind === "video" || one.kind === "image") ? one.path : "";
    return [
      { id: "split", label: "Split at playhead", icon: "scissors", disabled: !underPlayhead, onSelect: () => void splitAtPlayhead() },
      { id: "slice", label: `Slice at ${st.activeLane} markers`, icon: "scissors", onSelect: () => void sliceSelection(live.current.markers, false) },
      { id: "cycle", label: "Slice and cycle sources", icon: "scissors", disabled: live.current.project.sources.length < 2, onSelect: () => void sliceSelection(live.current.markers, true) },
      { id: "subject", label: "Split subject", icon: "scan-face", disabled: !hasMatte, onSelect: () => void splitSubjectOfSelection() },
      {
        id: "pin",
        label: allPinned ? "Unpin" : "Pin",
        icon: allPinned ? "pin-off" : "pin",
        separator: true,
        onSelect: () => {
          let next = doc;
          for (const c of clips) next = withClip(next, c.id, { pinned: !allPinned, auto: c.auto });
          commit(next);
        },
      },
      { id: "dup", label: "Duplicate", icon: "copy", onSelect: () => void duplicateSelection() },
      { id: "del", label: "Delete", icon: "trash-2", onSelect: () => void deleteSelection() },
      {
        id: "reveal",
        label: "Reveal source",
        icon: "folder-open",
        separator: true,
        disabled: !file,
        onSelect: () => void LibraryService.RevealPath(file).catch((err: unknown) => toast({ title: toAppError(err).message, tone: "danger" })),
      },
    ];
  };

  // ---- track edits ----
  const edit = (next: NormalProject | null) => void commit(next);
  const tracksTopFirst = project.tracks.map((t, i) => ({ t, i })).reverse();
  const matteBadge = (c: EditClip): MatteBadge => (c.matte ? (mattes[c.matte.id]?.ready ? "ready" : "working") : "none");
  const visible = { from: scrollMs - 200 / Math.max(1, pps) * 1000, to: scrollMs + ((timeWidth + 200) * 1000) / Math.max(1, pps) };
  const removingTrack = project.tracks.find((t) => t.id === removing);

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <Button size="sm" icon="plus" disabled={project.tracks.length >= 8} onClick={() => edit(addTrack(project, "video"))}>
          Track
        </Button>
        <Button size="sm" icon="sliders-horizontal" disabled={project.tracks.length >= 8} onClick={() => edit(addTrack(project, "adjust"))}>
          Adjustment track
        </Button>
        <Button size="sm" icon="type" onClick={() => addTextClip()}>
          Text
        </Button>
        <Button size="sm" icon="sparkles" onClick={() => addVisualClip()}>
          Visual
        </Button>
        <span className={styles.toolbarHint}>{project.tracks.length} of 8 tracks</span>
      </div>
      <div className={styles.rows} ref={rootRef} role="region" aria-label="Tracks" id="es-tracks">
        {tracksTopFirst.map(({ t: track, i }) => (
          <div key={track.id} className={cx(styles.row, track.locked && styles.locked)} style={{ height: track.kind === "adjust" ? ADJUST_ROW_PX : VIDEO_ROW_PX }}>
            <TrackHeader
              track={track}
              index={i}
              count={project.tracks.length}
              selected={selectedTrack === track.id}
              onSelect={() => useEditStudio.getState().select({ kind: "track", id: track.id })}
              onRename={(name) => edit(renameTrack(project, track.id, name))}
              onMute={(m) => edit(setTrackMuted(project, track.id, m))}
              onLock={(l) => edit(setTrackLocked(project, track.id, l))}
              onMove={(dir) => edit(reorderTrack(project, track.id, i + dir))}
              onKind={(k) => edit(setTrackKind(project, track.id, k))}
              onRemove={() => (track.clips.length ? setRemoving(track.id) : edit(removeTrack(project, track.id)))}
              matteRole={matteRoleOf(project.tracks, i)}
            />
            <div
              className={cx(styles.timeArea, track.kind === "adjust" && styles.adjustArea, matteRoleOf(project.tracks, i) === "matte" && styles.matteArea)}
              data-track-row={track.id}
              onPointerDown={(e) => onAreaPointerDown(e, track.id)}
              onDoubleClick={(e) => onAreaDoubleClick(e, track.id)}
            >
              {track.clips.map((c) => {
                if (timeWidth > 0 && (c.endMs < visible.from || c.startMs > visible.to)) return null;
                return (
                  <ClipView
                    key={c.id}
                    clip={c}
                    left={msToX(c.startMs, pps, scrollMs)}
                    width={((c.endMs - c.startMs) * pps) / 1000}
                    selected={selected.has(c.id)}
                    status={c.kind === "video" || c.kind === "image" ? clipStatus(c, sources[c.path]) : "ok"}
                    pastEnd={c.endMs > D}
                    sourceMs={sources[c.path]?.info.durationMs ?? 0}
                    fps={project.fps}
                    matte={matteBadge(c)}
                    onPointerDown={onClipPointerDown}
                    onTrimDown={onTrimDown}
                    onContextMenu={onClipContextMenu}
                  />
                );
              })}
              {D > 0 && <div className={styles.endLine} style={{ left: msToX(D, pps, scrollMs) }} aria-hidden="true" />}
            </div>
          </div>
        ))}
        <SongTrack timeWidth={timeWidth} />
        <Playhead />
        {hint && (
          <div className={styles.hint} style={{ left: HEADER_PX + msToX(hint.ms, pps, scrollMs) }} role="status">
            {hint.label}
          </div>
        )}
        {marquee && (
          <div
            className={styles.marquee}
            style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }}
            aria-hidden="true"
          />
        )}
      </div>
      <TimeScrollbar width={width} durationMs={D} />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={closeMenu} />}
      <ConfirmDialog
        open={!!removingTrack}
        title="Remove this track?"
        tone="danger"
        confirmLabel="Remove"
        body={removingTrack ? `"${removingTrack.name}" and its ${removingTrack.clips.length} ${removingTrack.clips.length === 1 ? "clip" : "clips"} are removed from the edit. You can undo it.` : null}
        onConfirm={() => {
          if (removing) edit(removeTrack(project, removing));
          setRemoving(null);
        }}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}

/** Part B: a track's role in a track matte (the track directly above a matted video track is its matte). */
export function matteRoleOf(tracks: readonly { kind: string; matte?: string; muted: boolean }[], i: number): "matte" | "matted" | null {
  const t = tracks[i];
  const above = tracks[i + 1];
  const below = tracks[i - 1];
  if (t?.kind === "video" && t.matte && above?.kind === "video" && !above.muted) return "matted";
  if (t?.kind === "video" && below?.kind === "video" && below.matte && !t.muted) return "matte";
  return null;
}
