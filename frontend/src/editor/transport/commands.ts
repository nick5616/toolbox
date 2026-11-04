/**
 * Edit Studio keyboard shortcuts and palette commands (Phase 9 SPEC §14.11).
 * Mounted once while the editor is open.
 */
import { useRef } from "react";
import { useCommands, type Command } from "@/lib/commands";
import { useShortcut } from "@/lib/shortcuts";
import { editLength } from "@/viz/edit/types";
import { useNewEditRequest } from "../home/newEditRequest";
import { profileTitle, useEditorProfile } from "../profileContext";
import { useEditStudio, useMarkers } from "@/editor/store";
import { flushEdit } from "@/editor/useEditAutosave";
import { commit, currentDoc, deleteSelection, duplicateSelection, splitAtPlayhead, splitSubjectOfSelection } from "../timeline/actions";
import { addTrack, laneMarkersMs, neighbourMarker } from "../timeline/ops";
import { EDIT_SHORTCUTS } from "./shortcuts";
import { frameMs, nextRate, visibleLanes } from "./logic";
import { getPlayer, seekTo } from "./player";

const combosOf = (id: string): string[] => EDIT_SHORTCUTS.find((s) => s.id === id)?.combos ?? [];

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

  const laneMs = (): number[] => laneMarkersMs(live.current, useEditStudio.getState().activeLane);
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
    const p = getPlayer();
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
  useShortcut(combosOf("delete"), () => void deleteSelection());
  useShortcut(combosOf("duplicate"), () => void duplicateSelection());
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
    cmd("add-adjust-track", "Add adjustment track", () => {
      const doc = currentDoc();
      if (doc) commit(addTrack(doc, "adjust"));
    }, { icon: "sliders-horizontal" }),
  ]);
  profile.useCommands?.();
}
