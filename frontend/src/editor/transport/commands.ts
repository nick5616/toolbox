/**
 * Edit Studio keyboard shortcuts and palette commands (Phase 9 SPEC §14.11).
 * Mounted once while the editor is open.
 */
import { useEffect, useRef } from "react";
import { toast } from "@/components";
import { useCommands, type Command } from "@/lib/commands";
import { useShortcut } from "@/lib/shortcuts";
import { editLength } from "@/viz/edit/types";
import { useNewEditRequest } from "../home/newEditRequest";
import { profileTitle, useEditorProfile } from "../profileContext";
import { useEditStudio, useMarkers } from "@/editor/store";
import { flushEdit } from "@/editor/useEditAutosave";
import {
  addMarkerAtPlayhead,
  commit,
  copySelection,
  currentDoc,
  customMarkerTimes,
  deleteMarkers,
  deleteSelection,
  duplicateSelection,
  editEndMs,
  jumpToEditPoint,
  jumpToKeyframe,
  pasteAtPlayhead,
  rippleDeleteSelection,
  splitAtPlayhead,
  splitSubjectOfSelection,
  toggleLinkSelection,
} from "../timeline/actions";
import { addTrack, laneMarkersMs, neighbourMarker } from "../timeline/ops";
import { currentRange, markIn, markOut, useTimelineStore, type TimelineTool } from "../timeline/timelineStore";
import { zoomFit, zoomIn, zoomOut } from "../timeline/zoomActions";
import { EDIT_SHORTCUTS } from "./shortcuts";
import { frameMs, nextRate, visibleLanes } from "./logic";
import { getPlayer, seekTo } from "./player";

const combosOf = (id: string): string[] => EDIT_SHORTCUTS.find((s) => s.id === id)?.combos ?? [];

/** What the playback clock adds in Phase 21 (E2): reverse play and loop play. Guarded so the keys still work without them. */
interface PlayerExt {
  reverse?(): void;
  loop?(range: { inMs: number; outMs: number } | null): void;
  setLoop?(range: { inMs: number; outMs: number } | null): void;
}

function setPlayerLoop(range: { inMs: number; outMs: number } | null): void {
  const p = getPlayer() as (ReturnType<typeof getPlayer> & PlayerExt) | null;
  p?.loop?.(range);
  if (!p?.loop) p?.setLoop?.(range);
}

const TOOL_KEYS: ReadonlyArray<[string, TimelineTool]> = [
  ["toolSelect", "select"],
  ["toolRazor", "razor"],
  ["toolRipple", "ripple"],
  ["toolRoll", "roll"],
  ["toolSlip", "slip"],
];

/** Space on a focused button activates the button instead. */
function onButton(e: KeyboardEvent): boolean {
  return e.target instanceof HTMLElement && !!e.target.closest("button, [role=button], a, [role=switch]");
}

function selectAllOnTrack(): void {
  const doc = currentDoc();
  if (!doc) return;
  const st = useEditStudio.getState();
  let track: (typeof doc.tracks)[number] | undefined;
  if (st.selection?.kind === "track") {
    const id = st.selection.id;
    track = doc.tracks.find((t) => t.id === id);
  } else if (st.selection?.kind === "clips" && st.selection.ids[0]) {
    const first = st.selection.ids[0];
    track = doc.tracks.find((t) => t.clips.some((c) => c.id === first));
  }
  track ??= doc.tracks.find((t) => t.kind === "video" && t.clips.length) ?? doc.tracks.find((t) => t.clips.length);
  if (track?.clips.length) st.select({ kind: "clips", ids: track.clips.map((c) => c.id) });
}

export function useEditCommands(): void {
  const profile = useEditorProfile();
  const markers = useMarkers();
  const live = useRef(markers);
  live.current = markers;

  // The Video Editor's markers are the ruler's flags; Edit Studio's are its lanes' (and keep M, [ and ] for the lanes).
  const videoEditor = profile.song === "optional";
  const laneMs = (): number[] => {
    if (videoEditor) {
      const doc = currentDoc();
      return doc ? customMarkerTimes(doc) : [];
    }
    return laneMarkersMs(live.current, useEditStudio.getState().activeLane);
  };
  const D = (): number => {
    const p = currentDoc();
    return p ? editLength(p) : 0;
  };
  const step = (dir: -1 | 1) => {
    const doc = currentDoc();
    if (!doc) return;
    getPlayer()?.pause();
    const f = frameMs(doc.fps);
    const k = Math.round(useEditStudio.getState().playheadMs / f) + dir;
    seekTo(Math.max(0, Math.min(D(), k * f)));
  };
  const jump = (dir: -1 | 1) => {
    const m = neighbourMarker(laneMs(), useEditStudio.getState().playheadMs, dir);
    if (m !== null) seekTo(m);
  };

  useShortcut(combosOf("play"), (e) => {
    if (onButton(e)) return;
    e.preventDefault();
    getPlayer()?.toggle();
  }, { preventDefault: false });
  useShortcut(combosOf("pause"), () => getPlayer()?.pause());
  useShortcut(combosOf("forward"), () => {
    const p = getPlayer();
    if (!p) return;
    if (useEditStudio.getState().playing) p.setRate(nextRate(p.rate()));
    else p.play();
  });
  useShortcut(combosOf("back"), () => {
    const p = getPlayer() as (ReturnType<typeof getPlayer> & PlayerExt) | null;
    // Reverse play (E2's clock) when there is one; otherwise jump back 2 s and play, as before.
    if (p?.reverse) {
      p.reverse();
      return;
    }
    seekTo(useEditStudio.getState().playheadMs - 2000);
    p?.play();
  });
  useShortcut(combosOf("prevFrame"), () => step(-1));
  useShortcut(combosOf("nextFrame"), () => step(1));
  useShortcut(combosOf("prevMarker"), () => jump(-1));
  useShortcut(combosOf("nextMarker"), () => jump(1));
  useShortcut(combosOf("home"), () => seekTo(0));
  useShortcut(combosOf("end"), () => seekTo(D()));
  useShortcut(combosOf("split"), () => void splitAtPlayhead());
  useShortcut(combosOf("delete"), () => {
    if (deleteSelection()) return;
    // The Video Editor's markers: Delete removes the selected flag (Edit Studio's lanes handle their own).
    const sel = useEditStudio.getState().selection;
    const doc = currentDoc();
    if (videoEditor && doc && sel?.kind === "markers" && commit(deleteMarkers(doc, sel.ids))) useEditStudio.getState().select(null);
  });
  useShortcut(combosOf("duplicate"), () => void duplicateSelection());
  useShortcut(combosOf("rippleDelete"), () => void rippleDeleteSelection());
  // Clipboard: only when clips are selected / copied, so text copy and paste elsewhere keep working.
  useShortcut(combosOf("copy"), (e) => {
    if (useEditStudio.getState().selection?.kind === "clips") {
      e.preventDefault();
      copySelection(false);
    }
  }, { preventDefault: false });
  useShortcut(combosOf("cut"), (e) => {
    if (useEditStudio.getState().selection?.kind === "clips") {
      e.preventDefault();
      copySelection(true);
    }
  }, { preventDefault: false });
  useShortcut(combosOf("paste"), (e) => {
    if (!useTimelineStore.getState().clipboard) return;
    e.preventDefault();
    pasteAtPlayhead("overwrite");
  }, { preventDefault: false });
  useShortcut(combosOf("pasteInsert"), (e) => {
    if (!useTimelineStore.getState().clipboard) return;
    e.preventDefault();
    pasteAtPlayhead("insert");
  }, { preventDefault: false });
  useShortcut(combosOf("link"), () => void toggleLinkSelection());

  // Tools.
  const setTool = useTimelineStore((s) => s.setTool);
  for (const [id, tool] of TOOL_KEYS) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- the list is a constant: the same hooks run every render
    useShortcut(combosOf(id), () => setTool(tool));
  }
  useShortcut(combosOf("snapping"), () => useEditStudio.getState().setSnap(!useEditStudio.getState().snap));

  // Zoom.
  useShortcut(combosOf("zoomIn"), () => zoomIn());
  useShortcut(combosOf("zoomOut"), () => zoomOut());
  useShortcut(combosOf("zoomFit"), () => zoomFit());

  // The In/Out range and looping it.
  useShortcut(combosOf("markIn"), () => markIn(useEditStudio.getState().playheadMs, editEndMs()));
  useShortcut(combosOf("markOut"), () => markOut(useEditStudio.getState().playheadMs));
  useShortcut(combosOf("clearRange"), () => {
    useTimelineStore.getState().clearRange();
    setPlayerLoop(null);
  });
  useShortcut(combosOf("loop"), () => {
    const st = useTimelineStore.getState();
    if (st.loop) {
      st.setLoop(false);
      setPlayerLoop(null);
      return;
    }
    const range = currentRange();
    if (!range) {
      toast({ title: "Set a range first", description: "Press I and O to mark where it starts and ends.", tone: "warn" });
      return;
    }
    st.setLoop(true);
    setPlayerLoop(range);
    seekTo(range.inMs);
    getPlayer()?.play();
  });

  // Navigation.
  useShortcut(combosOf("prevEdit"), () => void jumpToEditPoint(-1));
  useShortcut(combosOf("nextEdit"), () => void jumpToEditPoint(1));
  useShortcut(combosOf("back1s"), () => seekTo(Math.max(0, useEditStudio.getState().playheadMs - 1000)));
  useShortcut(combosOf("fwd1s"), () => seekTo(Math.min(Math.max(D(), useEditStudio.getState().playheadMs), useEditStudio.getState().playheadMs + 1000)));
  useShortcut(combosOf("prevKey"), () => void jumpToKeyframe(-1));
  useShortcut(combosOf("nextKey"), () => void jumpToKeyframe(1));
  // M: a marker flag on the ruler (Video Editor only: Edit Studio's Lanes own M there).
  useShortcut("M", () => void addMarkerAtPlayhead(), { when: videoEditor });

  // A loop that is on follows the range as it changes.
  const loopOn = useTimelineStore((s) => s.loop);
  const rangeIn = useTimelineStore((s) => s.rangeInMs);
  const rangeOut = useTimelineStore((s) => s.rangeOutMs);
  useEffect(() => {
    if (!loopOn) return;
    const range = currentRange();
    setPlayerLoop(range);
    if (!range) useTimelineStore.getState().setLoop(false);
  }, [loopOn, rangeIn, rangeOut]);
  useShortcut(combosOf("undo"), () => useEditStudio.getState().undo());
  useShortcut(combosOf("redo"), () => useEditStudio.getState().redo());
  useShortcut(combosOf("selectAll"), () => selectAllOnTrack());
  useShortcut(combosOf("lane"), (e) => {
    const doc = currentDoc();
    if (!doc) return;
    const lane = visibleLanes(doc)[Number(e.key) - 1];
    if (lane) useEditStudio.getState().setActiveLane(lane);
  });

  // Edit Studio needs an analysed song; the Video Editor needs nothing.
  const ready = () => profile.song !== "analyzed" || useEditStudio.getState().analysisState === "ready";
  const cmd = (id: string, title: string, run: Command["run"], extra: Partial<Command> = {}): Command => ({ id: `${profile.moduleId}.${id}`, title, section: profileTitle(profile), run, ...extra });
  useCommands([
    cmd(
      "new",
      `New ${profile.noun}`,
      async () => {
        await flushEdit();
        useEditStudio.getState().close();
        useNewEditRequest.getState().request();
      },
      { icon: "plus" },
    ),
    cmd("export", "Export…", () => useEditStudio.getState().openDialog({ kind: "export" }), { icon: "download", enabled: ready }),
    cmd("split-subject", "Split subject", () => void splitSubjectOfSelection(), { enabled: ready }),
    cmd("safe-zones", "Toggle safe zones", () => useEditStudio.getState().setSafeZones(!useEditStudio.getState().safeZones), { icon: "frame" }),
    cmd("snap", "Toggle snapping", () => useEditStudio.getState().setSnap(!useEditStudio.getState().snap)),
    cmd("add-track", "Add track", () => {
      const doc = currentDoc();
      if (doc) commit(addTrack(doc, "video"));
    }, { icon: "layers" }),
    cmd("add-audio-track", "Add audio track", () => {
      const doc = currentDoc();
      if (doc) commit(addTrack(doc, "audio"));
    }, { icon: "music" }),
    cmd("zoom-fit", "Zoom the timeline to fit the edit", () => zoomFit(), { icon: "maximize" }),
    cmd("add-adjust-track", "Add adjustment track", () => {
      const doc = currentDoc();
      if (doc) commit(addTrack(doc, "adjust"));
    }, { icon: "sliders-horizontal" }),
  ]);
  profile.useCommands?.();
}
