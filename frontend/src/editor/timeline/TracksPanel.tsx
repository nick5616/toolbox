/**
 * Tracks, clips, snapping and the song track (Phase 9 SPEC §14.5; Phase 21
 * §B2). DOM rows (a header column, then the time area on the shared
 * pps/scrollMs), pointer drags that record one undo step each (select, razor,
 * ripple, roll and slip tools), a marquee, gaps, links, context menus and
 * drops from the Sources panel.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ConfirmDialog, MenuButton, cx, toast, type MenuItem } from "@/components";
import { LibraryService, type EditClip } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import type { NormalProject } from "@/viz/edit/defaults";
import { editLength } from "@/viz/edit/types";
import { HEADER_PX, msToX, useTimelinePan, useTimelineWheel, xToMs } from "@/editor/geometry";
import { dragWantsSourceLength, useSourceDropTarget, type SourceDropInfo } from "../sources/dragSource";
import { useEditStudio, useMarkers, useProject } from "@/editor/store";
import { seekTo } from "../transport/player";
import {
  clickSelection,
  closeSelectedGap,
  collapseDrag,
  commit,
  copySelection,
  deleteSelection,
  detachAudioOfSelection,
  dropOnNewTrack,
  duplicateSelection,
  insertSources,
  pasteAtPlayhead,
  razorCut,
  rippleDeleteSelection,
  selectedClipIds,
  splitAtPlayhead,
  splitSubjectOfSelection,
  toggleLinkSelection,
} from "./actions";
import { clipStatus, sourceWindow } from "./clipInfo";
import { ClipView, type MatteBadge } from "./ClipView";
import { ContextMenu, type ContextItem } from "./ContextMenu";
import { canDetachAudio, cutAt, gapAt, rippleTrim, rollEdit, slipClip, sourceRange } from "./edit";
import { addTrack, insertAdjustClip, laneMarkersMs, moveClips, duplicateClips, removeTrack, renameTrack, reorderTrack, setTrackHeight, setTrackKind, setTrackLocked, setTrackMuted, setTrackSolo, trackHeightOf, trimClip, usesSource, withLinked, type DropMode, type TrackHeight } from "./ops";
import { buildSnapTargets, snapPoint, snapSpan } from "./snapping";
import { SongTrack } from "./SongTrack";
import { timelineRoomMs } from "./songFile";
import { useEditorProfile } from "../profileContext";
import { useEffectiveFocus } from "../focus";
import type { Marker } from "@/viz/edit/types";
import { TrackHeader } from "./TrackHeader";
import { withClip } from "@/editor/doc";
import styles from "./TracksPanel.module.css";
import tl from "./Timeline.module.css";
import { TimeScrollbar } from "./TimeScrollbar";
import { TimelineToolbar } from "./TimelineToolbar";
import { addTextClip } from "../text/addText";
import { addVisualClip } from "../visual/addVisual";
import { startScrub } from "./scrub";
import { SelectionBar } from "../selection/SelectionBar";
import { CLIP_INSET_PX, lanePx, nearestHeight, rowPx } from "./trackHeights";
import { useTimelineStore } from "./timelineStore";

export const VIDEO_ROW_PX = 56;
export const ADJUST_ROW_PX = 36;
/** Thin rows while the music is the focus (Edit Studio's Music view): the lanes get the room. */
export const THIN_VIDEO_ROW_PX = 34;
export const THIN_ADJUST_ROW_PX = 26;
const DRAG_PX = 4;
let dragSeq = 0;
const NO_MARKERS: readonly Marker[] = [];

interface Hint {
  ms: number;
  label: string;
}

interface Menu {
  x: number;
  y: number;
  /** A right-click on empty track space. */
  area?: { trackId: string; ms: number };
}

const fmtSrc = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;

function Playhead({ durationMs, timeLeft }: { durationMs: number; timeLeft: () => number }) {
  const ms = useEditStudio((s) => s.playheadMs);
  const pps = useEditStudio((s) => s.pps);
  const scrollMs = useEditStudio((s) => s.scrollMs);
  const x = msToX(ms, pps, scrollMs);
  if (x < -1) return null;
  return (
    <div className={styles.playhead} style={{ left: HEADER_PX + x }}>
      {/* A wide invisible grip: drag the playhead anywhere along the tracks. */}
      <div className={styles.playheadGrip} data-tip="Drag to move the playhead along the edit" onPointerDown={(e) => startScrub(e, timeLeft, durationMs)} />
    </div>
  );
}

export function TracksPanel() {
  const project = useProject();
  if (!project) return null;
  return <Tracks project={project} />;
}

/** The ids of `id`'s link group that sit on unlocked tracks (empty without a link). */
function partnersOf(doc: NormalProject, id: string): string[] {
  const locked = new Set(doc.tracks.filter((t) => t.locked).flatMap((t) => t.clips.map((c) => c.id)));
  return withLinked(doc, [id]).filter((x) => x !== id && !locked.has(x));
}

function Tracks({ project }: { project: NormalProject }) {
  const pps = useEditStudio((s) => s.pps);
  const scrollMs = useEditStudio((s) => s.scrollMs);
  const selection = useEditStudio((s) => s.selection);
  const sources = useEditStudio((s) => s.sources);
  const mattes = useEditStudio((s) => s.mattes);
  const tool = useTimelineStore((s) => s.tool);
  const gap = useTimelineStore((s) => s.gap);
  const slip = useTimelineStore((s) => s.slip);
  const markers = useMarkers();
  const D = editLength(project);
  const room = timelineRoomMs(project);
  const profile = useEditorProfile();
  const snapMarkers = profile.useSnapMarkers?.() ?? NO_MARKERS;
  const Toolbar = profile.TracksToolbar;
  const Overlay = profile.TracksOverlay;
  const focus = useEffectiveFocus();
  const thin = profile.TimelineTop !== undefined && focus === "compose";

  const rootRef = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [hint, setHint] = useState<Hint | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [razorX, setRazorX] = useState<number | null>(null);

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
  useTimelineWheel(root, room);
  useTimelinePan(root, room);

  const timeWidth = Math.max(0, width - HEADER_PX);
  const setViewWidth = useTimelineStore((s) => s.setViewWidth);
  useEffect(() => {
    if (timeWidth > 0) setViewWidth(timeWidth);
  }, [timeWidth, setViewWidth]);

  // Ctrl at the time of a drop makes it an insert (the drop callback doesn't carry modifiers).
  const ctrlDown = useRef(false);
  useEffect(() => {
    const read = (e: PointerEvent | KeyboardEvent) => {
      ctrlDown.current = e.ctrlKey || e.metaKey;
    };
    const events = ["pointermove", "pointerup", "keydown", "keyup"] as const;
    for (const n of events) window.addEventListener(n, read as EventListener, true);
    return () => {
      for (const n of events) window.removeEventListener(n, read as EventListener, true);
    };
  }, []);

  // While playing, keep the playhead in view: when it leaves the right 8 %,
  // page forward so it sits 10 % in from the left (lanes follow the same scroll).
  useEffect(() => {
    if (timeWidth <= 0) return;
    return useEditStudio.subscribe((s, prev) => {
      if (!s.playing || s.playheadMs === prev.playheadMs) return;
      const visible = (timeWidth * 1000) / s.pps;
      const t = s.playheadMs;
      if (t >= s.scrollMs && t <= s.scrollMs + visible * 0.92) return;
      const maxScroll = Math.max(0, live.current.room - visible);
      s.setView(s.pps, Math.min(maxScroll, Math.max(0, t - visible * 0.1)));
    });
  }, [timeWidth]);
  const selected = useMemo(() => new Set(selection?.kind === "clips" ? selection.ids : []), [selection]);
  const selectedTrack = selection?.kind === "track" ? selection.id : null;

  const live = useRef({ project, markers, snapMarkers, sources, D, room });
  live.current = { project, markers, snapMarkers, sources, D, room };

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
  const snapTargets = (base: NormalProject, exclude?: ReadonlySet<string>) =>
    buildSnapTargets({ project: base, markers: live.current.snapMarkers, playheadMs: useEditStudio.getState().playheadMs, ...(exclude ? { exclude } : {}) });
  const sourceLen = (path: string): number => live.current.sources[path]?.info.durationMs ?? 0;

  // ---- slipping (Y) ----
  const startSlip = (e: ReactPointerEvent<HTMLDivElement>, clip: EditClip, base: NormalProject, ids: string[]) => {
    if (!usesSource(clip)) return;
    const startX = e.clientX;
    const key = `slip-${++dragSeq}`;
    const st = useEditStudio.getState();
    const startPast = st.history?.past.length ?? 0;
    const w = sourceWindow(clip, base.fps);
    const len = clip.endMs - clip.startMs;
    const rate = len > 0 ? (w.toMs - w.fromMs) / len : 1;
    // The preview shows the clip's first frame while slipping: park the playhead on it.
    seekTo(clip.startMs);
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < 2) return;
      moved = true;
      const now = useEditStudio.getState();
      // Dragging right pulls earlier material into the clip.
      const delta = -((ev.clientX - startX) * 1000 * rate) / now.pps;
      let next: NormalProject = base;
      for (const id of ids) {
        const c: EditClip | undefined = next.tracks.flatMap((t) => t.clips).find((x) => x.id === id);
        if (c) next = slipClip(next, id, delta, { sourceMs: sourceLen(c.path) }) ?? next;
      }
      const moved1 = next.tracks.flatMap((t) => t.clips).find((x) => x.id === clip.id);
      if (moved1) {
        const r = sourceRange(next, moved1);
        useTimelineStore.getState().setSlip({ clipId: clip.id, inMs: r.inMs, outMs: r.outMs });
      }
      if (next !== base) now.edit(next, key);
      else if (now.history?.present !== base) now.edit(base, key);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      useTimelineStore.getState().setSlip(null);
      collapseDrag(startPast, base);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // ---- dragging a clip ----
  const onClipPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>, clip: EditClip) => {
    if (e.button !== 0) return;
    const st = useEditStudio.getState();
    const base = st.history?.present;
    if (!base) return;
    const tool = useTimelineStore.getState().tool;
    useTimelineStore.getState().selectGap(null);
    const home = base.tracks.find((t) => t.clips.some((c) => c.id === clip.id));

    if (tool === "razor") {
      // A click cuts the clip (and its links) at the pointer; Shift cuts every unlocked track.
      e.preventDefault();
      let ms = msAtX(e.clientX);
      if (st.snap && !e.altKey) ms = snapPoint(ms, snapTargets(base), st.pps)?.ms ?? ms;
      razorCut(clip.id, ms, e.shiftKey);
      return;
    }

    const cur = selectedClipIds(st.selection);
    const group = clickSelection(base, clip.id, e.altKey);
    const additive = e.shiftKey;
    const toggle = e.ctrlKey || e.metaKey;
    let ids: string[];
    if (additive) ids = [...new Set([...cur, ...group])];
    else if (toggle) ids = cur.includes(clip.id) ? cur.filter((x) => !group.includes(x)) : [...new Set([...cur, ...group])];
    else ids = cur.includes(clip.id) && !e.altKey ? cur : group;
    st.select(ids.length ? { kind: "clips", ids } : null);
    if (additive || toggle || !ids.includes(clip.id)) return;
    if (!home || home.locked) {
      seekTo(Math.max(0, Math.min(live.current.D, msAtX(e.clientX))));
      return;
    }
    if (tool === "slip") {
      startSlip(e, clip, base, ids);
      return;
    }
    if (tool === "ripple" || tool === "roll") {
      // These tools work on edges; a click on the body just selects and seeks.
      seekTo(Math.max(0, Math.min(live.current.D, msAtX(e.clientX))));
      return;
    }

    const copy = e.altKey;
    const startX = e.clientX;
    const startY = e.clientY;
    const key = `move-${++dragSeq}`;
    const startPast = st.history?.past.length ?? 0;
    const targets = snapTargets(base, copy ? undefined : new Set(ids));
    // Only a group on one track moves between tracks (a linked video and its audio stay on theirs).
    const oneTrack = new Set(ids.map((id) => base.tracks.findIndex((t) => t.clips.some((c) => c.id === id)))).size === 1;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_PX) return;
      moved = true;
      const now = useEditStudio.getState();
      let delta = ((ev.clientX - startX) * 1000) / now.pps;
      // Alt at the start copies; Alt pressed later skips snapping (as before).
      if (now.snap && (copy || !ev.altKey)) {
        const s = snapSpan(clip.startMs + delta, clip.endMs + delta, targets, now.pps);
        delta += s.deltaMs;
        setHint(s.target ? { ms: s.target.ms, label: s.target.label } : null);
      } else setHint(null);
      const mode: DropMode = ev.ctrlKey || ev.metaKey ? "insert" : "overwrite";
      const to = oneTrack ? (rowAt(ev.clientY) ?? undefined) : undefined;
      const next = copy ? duplicateClips(base, ids, Math.round(delta), to, mode) : moveClips(base, ids, Math.round(delta), to, mode);
      if (next) now.edit(next, key);
      else if (now.history?.present !== base) now.edit(base, key);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setHint(null);
      collapseDrag(startPast, base);
      if (moved && copy) {
        // Select the copies.
        const before = new Set(base.tracks.flatMap((t) => t.clips.map((c) => c.id)));
        const after = useEditStudio.getState().history?.present;
        const made = after?.tracks.flatMap((t) => t.clips.filter((c) => !before.has(c.id)).map((c) => c.id)) ?? [];
        if (made.length) useEditStudio.getState().select({ kind: "clips", ids: made });
      }
      if (!moved && ids.length > 1 && !e.altKey) {
        const only = clickSelection(base, clip.id, false);
        useEditStudio.getState().select({ kind: "clips", ids: only.length > 1 ? ids : [clip.id] });
      }
      // A click (no drag) on a clip also moves the playhead there.
      if (!moved && ev.type === "pointerup") seekTo(Math.max(0, Math.min(live.current.D, msAtX(ev.clientX))));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads live state
  }, []);

  // ---- trimming (select: with links; B: ripple; N: roll) ----
  const onTrimDown = useCallback((e: ReactPointerEvent<HTMLElement>, clip: EditClip, edge: "start" | "end") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const st = useEditStudio.getState();
    const base = st.history?.present;
    if (!base) return;
    const tool = useTimelineStore.getState().tool;
    if (tool === "razor" || tool === "slip") return;
    const home = base.tracks.find((t) => t.clips.some((c) => c.id === clip.id));
    if (!home || home.locked) return;
    const partners = e.altKey ? [] : partnersOf(base, clip.id);
    st.select({ kind: "clips", ids: [clip.id, ...partners] });
    // Roll: the other side of the cut.
    let rollWith: { left: EditClip; right: EditClip } | null = null;
    if (tool === "roll") {
      const sorted = home.clips.slice().sort((a, b) => a.startMs - b.startMs);
      const cut = cutAt(base, home.id, edge === "start" ? clip.startMs : clip.endMs, 2);
      if (cut && sorted.length) rollWith = { left: cut[0], right: cut[1] };
      if (!rollWith) {
        toast({ title: "Roll needs a cut", description: "Drag the edge where two clips touch.", tone: "warn" });
        return;
      }
    }
    const startX = e.clientX;
    const key = `trim-${++dragSeq}`;
    const startPast = st.history?.past.length ?? 0;
    const from = edge === "start" ? clip.startMs : clip.endMs;
    const targets = snapTargets(base, new Set([clip.id, ...partners]));
    const onMove = (ev: PointerEvent) => {
      const now = useEditStudio.getState();
      let to = from + ((ev.clientX - startX) * 1000) / now.pps;
      if (now.snap && !ev.altKey) {
        const s = snapPoint(to, targets, now.pps);
        if (s) to = s.ms;
        setHint(s ? { ms: s.ms, label: s.label } : null);
      } else setHint(null);
      const target = Math.round(to);
      let next: NormalProject | null;
      if (rollWith) {
        next = rollEdit(base, rollWith.left.id, rollWith.right.id, target, { leftSourceMs: sourceLen(rollWith.left.path) });
      } else {
        const trim = tool === "ripple" ? rippleTrim : trimClip;
        next = trim(base, clip.id, edge, target, { sourceMs: sourceLen(clip.path) });
        const delta = target - from;
        for (const pid of partners) {
          const pc = (next ?? base).tracks.flatMap((t) => t.clips).find((c) => c.id === pid);
          if (!pc) continue;
          const pEdge = edge === "start" ? pc.startMs : pc.endMs;
          next = trim(next ?? base, pid, edge, pEdge + delta, { sourceMs: sourceLen(pc.path) }) ?? next;
        }
      }
      if (next) now.edit(next, key);
      else if (now.history?.present !== base) now.edit(base, key);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads live state
  }, []);

  // ---- empty space: click (select track + gap + seek) or marquee ----
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
        const ms = msAtX(ev.clientX);
        useEditStudio.getState().select({ kind: "track", id: trackId });
        // The empty stretch between clips can be selected: Delete closes it.
        useTimelineStore.getState().selectGap(gapAt(live.current.project, trackId, ms));
        seekTo(Math.max(0, Math.min(live.current.D, ms)));
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onAreaDoubleClick = (e: ReactMouseEvent<HTMLDivElement>, trackId: string) => {
    const doc = live.current.project;
    const track = doc.tracks.find((t) => t.id === trackId);
    if (e.target !== e.currentTarget || track?.kind !== "adjust") {
      if (!(e.target as HTMLElement).closest("[data-trim]")) seekTo(Math.max(0, Math.min(live.current.D, msAtX(e.clientX))));
      return;
    }
    const st = useEditStudio.getState();
    const ins = insertAdjustClip(doc, trackId, msAtX(e.clientX), { markersMs: laneMarkersMs(live.current.markers, st.activeLane) });
    if (ins && commit(ins.project)) st.select({ kind: "clips", ids: [ins.clip.id] });
  };

  const onAreaContextMenu = (e: ReactMouseEvent<HTMLDivElement>, trackId: string) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    const ms = msAtX(e.clientX);
    useEditStudio.getState().select({ kind: "track", id: trackId });
    useTimelineStore.getState().selectGap(gapAt(live.current.project, trackId, ms));
    setMenu({ x: e.clientX, y: e.clientY, area: { trackId, ms } });
  };

  // ---- drops from the Sources panel ----
  const onDrop = useCallback((info: SourceDropInfo) => {
    const doc = live.current.project;
    const trackId = rowAt(info.y);
    const mode = (info.shiftKey ?? dragWantsSourceLength()) ? "source" : "fill-next";
    const drop: DropMode = ctrlDown.current ? "insert" : "overwrite";
    const at = Math.max(0, msAtX(info.x));
    if (!trackId) {
      // Above the top track or below the last one: the sources get a track of their own.
      dropOnNewTrack(info.paths, at, mode, live.current.markers, drop);
      return;
    }
    const track = doc.tracks.find((t) => t.id === trackId);
    if (!track || track.kind === "adjust" || track.locked) {
      toast({ title: "Drop sources on an unlocked video or audio track", tone: "warn" });
      return;
    }
    insertSources(info.paths, track.id, at, mode, live.current.markers, drop);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads live state
  }, []);
  useSourceDropTarget(rootRef, onDrop);

  // ---- context menu ----
  const onClipContextMenu = useCallback((e: ReactMouseEvent<HTMLDivElement>, clip: EditClip) => {
    e.preventDefault();
    const st = useEditStudio.getState();
    if (!selectedClipIds(st.selection).includes(clip.id)) st.select({ kind: "clips", ids: clickSelection(st.history?.present ?? project, clip.id, e.altKey) });
    setMenu({ x: e.clientX, y: e.clientY });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads live state
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  const areaItems = (area: NonNullable<Menu["area"]>): ContextItem[] => {
    const g = gapAt(live.current.project, area.trackId, area.ms);
    const clipboard = useTimelineStore.getState().clipboard;
    return [
      {
        id: "close-gap",
        label: "Close gap",
        icon: "arrow-left-right",
        tip: g ? "Move the clips after this empty stretch left so there is no gap" : "Right-click the empty space between two clips to close it",
        disabled: !g,
        onSelect: () => {
          useTimelineStore.getState().selectGap(g);
          void closeSelectedGap();
        },
      },
      {
        id: "paste-here",
        label: "Paste here",
        icon: "copy",
        tip: clipboard ? "Paste the copied clips at this point (Ctrl+Shift+V inserts instead of overwriting)" : "Copy clips first (Ctrl+C)",
        disabled: !clipboard,
        separator: true,
        onSelect: () => {
          useEditStudio.getState().select({ kind: "track", id: area.trackId });
          seekTo(area.ms);
          void pasteAtPlayhead("overwrite");
        },
      },
    ];
  };

  const menuItems = (): ContextItem[] => {
    if (menu?.area) return areaItems(menu.area);
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
    const anyLinked = clips.some((c) => c.link);
    const canDetach = !!one && canDetachAudio(doc, one.id, sources[one.path]?.info.hasAudio ?? true);
    const clipboard = useTimelineStore.getState().clipboard;
    return [
      { id: "split", label: "Split at playhead", icon: "scissors", tip: underPlayhead ? "Cut the clip in two where the playhead is" : "Put the playhead inside the clip to split it", disabled: !underPlayhead, onSelect: () => void splitAtPlayhead() },
      ...(profile.clipMenuItems?.(clips, { markers: live.current.markers }) ?? []),
      { id: "subject", label: "Split subject", icon: "scan-face", tip: hasMatte ? "Separate the cut-out subject onto its own track above the background" : "Needs one clip with a finished cut-out (make one in the Inspector)", disabled: !hasMatte, onSelect: () => void splitSubjectOfSelection() },
      {
        id: "detach",
        label: "Detach audio",
        icon: "volume-2",
        tip: canDetach ? "Make a separate audio clip from this video's sound (linked, on the first free audio track) and silence the video clip" : one?.link ? "This clip is already linked; unlink it first" : "Select one video clip that has sound",
        disabled: !canDetach,
        onSelect: () => void detachAudioOfSelection(),
      },
      {
        id: "link",
        label: anyLinked ? "Unlink" : "Link",
        icon: anyLinked ? "unlink" : "link",
        tip: anyLinked ? "Let these clips move, trim and delete on their own again (Ctrl+L)" : clips.length > 1 ? "Make these clips select, move, trim and delete together (Ctrl+L)" : "Select two or more clips to link them",
        disabled: !anyLinked && clips.length < 2,
        onSelect: () => void toggleLinkSelection(),
      },
      {
        id: "pin",
        label: allPinned ? "Unpin" : "Pin",
        icon: allPinned ? "pin-off" : "pin",
        tip: allPinned ? "Let Auto-fill and Cut to beat change these clips again" : "Keep these clips as they are when Auto-fill or Cut to beat reshuffles the edit",
        separator: true,
        onSelect: () => {
          let next = doc;
          for (const c of clips) next = withClip(next, c.id, { pinned: !allPinned, auto: c.auto });
          commit(next);
        },
      },
      { id: "copy", label: "Copy", icon: "copy", tip: "Put the selected clips on the clipboard (Ctrl+C)", onSelect: () => void copySelection(false) },
      { id: "cut", label: "Cut", icon: "scissors", tip: "Copy the selected clips and delete them (Ctrl+X)", onSelect: () => void copySelection(true) },
      { id: "paste", label: "Paste at playhead", icon: "copy", tip: clipboard ? "Paste the copied clips at the playhead (Ctrl+V overwrites, Ctrl+Shift+V inserts)" : "Copy clips first (Ctrl+C)", disabled: !clipboard, onSelect: () => void pasteAtPlayhead("overwrite") },
      { id: "dup", label: "Duplicate", icon: "copy", tip: "Copy the selected clips right after themselves", onSelect: () => void duplicateSelection() },
      { id: "del", label: "Delete", icon: "trash-2", tip: "Remove the selected clips and leave a gap (you can undo it)", separator: true, onSelect: () => void deleteSelection() },
      { id: "ripple-del", label: "Ripple delete", icon: "trash-2", tip: "Remove the selected clips and close the gap they leave (Shift+Delete)", onSelect: () => void rippleDeleteSelection() },
      {
        id: "reveal",
        label: "Reveal source",
        icon: "folder-open",
        tip: file ? "Show the original file in your file manager" : "Select one video or photo clip to find its file",
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
  const full = project.tracks.length >= 8;
  const fullTip = "An edit can have at most 8 tracks";
  const addItems = (): MenuItem[] => [
    { id: "track", label: "Video track", icon: "plus", disabled: full, tip: full ? fullTip : "Add a video track on top: footage, photos, text and visuals layer upwards", onSelect: () => edit(addTrack(project, "video")) },
    { id: "audio", label: "Audio track", icon: "plus", disabled: full, tip: full ? fullTip : "Add an audio track at the bottom for music, voice and detached audio", onSelect: () => edit(addTrack(project, "audio")) },
    { id: "adjust", label: "Adjustment track", icon: "sliders-horizontal", disabled: full, tip: full ? fullTip : "A track whose effects apply to everything beneath it; double-click it to add an effect clip", onSelect: () => edit(addTrack(project, "adjust")) },
    { id: "text", label: "Text", icon: "type", tip: "Add a text clip: a title, a lyric line or any words over the picture", onSelect: () => addTextClip() },
    ...(profile.markerSignals ? [{ id: "visual", label: "Visual", icon: "sparkles", tip: "Add a music-reactive visual (shapes, light, particles) as a clip", onSelect: () => addVisualClip() }] : []),
  ];
  const removingTrack = project.tracks.find((t) => t.id === removing);

  /** Dragging a header's bottom edge picks the nearest of S / M / L. */
  const onResizeStart = (e: ReactPointerEvent<HTMLElement>, trackId: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const base = useEditStudio.getState().history?.present;
    const t = base?.tracks.find((x) => x.id === trackId);
    if (!base || !t) return;
    const startY = e.clientY;
    const startPx = rowPx(t.kind, trackHeightOf(t));
    const key = `height-${++dragSeq}`;
    const startPast = useEditStudio.getState().history?.past.length ?? 0;
    const onMove = (ev: PointerEvent) => {
      const h = nearestHeight(t.kind, startPx + (ev.clientY - startY));
      const next = setTrackHeight(base, trackId, h);
      const now = useEditStudio.getState();
      if (next) now.edit(next, key);
      else if (now.history?.present !== base && trackHeightOf(t) === h) now.edit(base, key);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      collapseDrag(startPast, base);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <SelectionBar />
        {Toolbar && <Toolbar />}
        <TimelineToolbar />
        {/* Last: the menu opens leftwards from its button. */}
        <MenuButton label="Add" icon="plus" size="sm" data-tip={full ? fullTip : "Add a video, audio or adjustment track, or a text clip"} items={addItems} />
      </div>
      <div
        className={cx(styles.rows, tool === "razor" && styles.toolRazor, tool === "slip" && styles.toolSlip, tool === "ripple" && styles.toolRipple, tool === "roll" && styles.toolRoll)}
        ref={rootRef}
        role="region"
        aria-label="Tracks"
        id="es-tracks"
        data-tool={tool}
        onPointerMove={tool === "razor" ? (e) => setRazorX(e.clientX - (rootRef.current?.getBoundingClientRect().left ?? 0)) : undefined}
        onPointerLeave={tool === "razor" ? () => setRazorX(null) : undefined}
      >
        {tracksTopFirst.map(({ t: track, i }) => {
          const heightSetting = trackHeightOf(track);
          const rowH = rowPx(track.kind, heightSetting, thin);
          const laneH = lanePx(rowH);
          const role = matteRoleOf(project.tracks, i);
          return (
            <div key={track.id} className={cx(styles.row, track.locked && styles.locked)} style={{ height: rowH }} data-track-id={track.id}>
              <TrackHeader
                track={track}
                index={i}
                count={project.tracks.length}
                selected={selectedTrack === track.id}
                full={full}
                onSelect={() => useEditStudio.getState().select({ kind: "track", id: track.id })}
                onRename={(name) => edit(renameTrack(project, track.id, name))}
                onMute={(m) => edit(setTrackMuted(project, track.id, m))}
                onSolo={(s) => edit(setTrackSolo(project, track.id, s))}
                onLock={(l) => edit(setTrackLocked(project, track.id, l))}
                onMove={(dir) => edit(reorderTrack(project, track.id, i + dir))}
                onKind={(k) => edit(setTrackKind(project, track.id, k))}
                onHeight={(h: TrackHeight) => edit(setTrackHeight(project, track.id, h))}
                onAddTrack={(k) => edit(addTrack(project, k))}
                onResizeStart={(e) => onResizeStart(e, track.id)}
                onRemove={() => (track.clips.length ? setRemoving(track.id) : edit(removeTrack(project, track.id)))}
                matteRole={role}
              />
              <div
                className={cx(styles.timeArea, track.kind === "adjust" && styles.adjustArea, track.kind === "audio" && styles.audioArea, role === "matte" && styles.matteArea)}
                data-track-row={track.id}
                onPointerDown={(e) => onAreaPointerDown(e, track.id)}
                onDoubleClick={(e) => onAreaDoubleClick(e, track.id)}
                onContextMenu={(e) => onAreaContextMenu(e, track.id)}
              >
                {gap && gap.trackId === track.id && (
                  <div className={tl.gapBox} style={{ left: msToX(gap.fromMs, pps, scrollMs), width: ((gap.toMs - gap.fromMs) * pps) / 1000 }} data-gap aria-hidden="true" />
                )}
                {track.clips.map((c) => {
                  if (timeWidth > 0 && (c.endMs < visible.from || c.startMs > visible.to)) return null;
                  const left = msToX(c.startMs, pps, scrollMs);
                  const w = ((c.endMs - c.startMs) * pps) / 1000;
                  return (
                    <ClipView
                      key={c.id}
                      clip={c}
                      left={left}
                      width={w}
                      selected={selected.has(c.id)}
                      status={c.kind === "video" || c.kind === "image" ? clipStatus(c, sources[c.path]) : "ok"}
                      pastEnd={c.endMs > D}
                      sourceMs={sources[c.path]?.info.durationMs ?? 0}
                      fps={project.fps}
                      matte={matteBadge(c)}
                      heightPx={laneH}
                      pps={pps}
                      viewFromPx={-left}
                      viewToPx={timeWidth - left}
                      hasAudio={sources[c.path]?.info.hasAudio ?? false}
                      locked={track.locked}
                      slipText={slip && slip.clipId === c.id ? `In ${fmtSrc(slip.inMs)} · Out ${fmtSrc(slip.outMs)}` : null}
                      onPointerDown={onClipPointerDown}
                      onTrimDown={onTrimDown}
                      onContextMenu={onClipContextMenu}
                    />
                  );
                })}
                {D > 0 && <div className={styles.endLine} style={{ left: msToX(D, pps, scrollMs) }} aria-hidden="true" />}
              </div>
            </div>
          );
        })}
        <SongTrack timeWidth={timeWidth} />
        {Overlay && <Overlay />}
        <Playhead durationMs={D} timeLeft={() => (rootRef.current?.getBoundingClientRect().left ?? 0) + HEADER_PX} />
        {razorX !== null && razorX > HEADER_PX && <div className={tl.razorGuide} style={{ left: razorX }} aria-hidden="true" />}
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
      <TimeScrollbar width={width} durationMs={room} />
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

export { CLIP_INSET_PX };
