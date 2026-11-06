/**
 * Edit Studio's composition profile (Phase 10, SPEC §5): the music layer
 * plugged into the Video Editor's slots. Everything beat- and song-specific
 * the editor shows comes from here; `src/editor/` never imports this folder.
 */
import { useRef } from "react";
import { useCommands, type Command } from "@/lib/commands";
import { useShortcut } from "@/lib/shortcuts";
import type { EditorProfile } from "@/editor/profile";
import { useEditStudio, useMarkers } from "@/editor/store";
import { sliceSelection } from "@/editor/timeline/actions";
import { EDIT_SHORTCUTS } from "@/editor/transport/shortcuts";
import { AutofillButton } from "./autofill/AutofillButton";
import { AutofillDialog } from "./autofill/AutofillDialog";
import { CutToBeat } from "./beatsync/CutButton";
import { HitOn } from "./beatsync/HitOn";
import { VelocityControl } from "./beatsync/VelocityControl";
import { exportSrt } from "./captions/exportSrt";
import { exportMarkers } from "./lanes/exportMarkers";
import { LanesPanel } from "./lanes/LanesPanel";
import { SectionBands } from "./lanes/SectionBands";
import { MomentsOverlay } from "./moments/MomentsOverlay";
import { SectionStyleDialog } from "./sectionstyle/SectionStyleDialog";
import { openStyleFromContext } from "./sectionstyle/useSectionStyle";
import { MUSIC_PANELS } from "./panels";
import { SetupPanel } from "./setup/SetupPanel";
import { SongChip } from "./song/SongChip";

function TimelineTop({ focus }: { focus: "compose" | "video" }) {
  return (
    <>
      <SectionBands />
      <LanesPanel compact={focus === "video"} />
    </>
  );
}

function TracksToolbar() {
  return <CutToBeat />;
}

/** Dialogs the music layer owns; they open from the editor's dialog state. */
function Dialogs() {
  const dialog = useEditStudio((s) => s.dialog);
  return (
    <>
      <AutofillDialog open={dialog?.kind === "autofill"} range={dialog?.kind === "autofill" ? dialog.range : null} onClose={() => useEditStudio.getState().openDialog(null)} />
      <SectionStyleDialog />
    </>
  );
}

const combosOf = (id: string): string[] => EDIT_SHORTCUTS.find((s) => s.id === id)?.combos ?? [];

/** Palette commands and the slice shortcut of the music layer. */
function useMusicCommands(): void {
  const markers = useMarkers();
  const live = useRef(markers);
  live.current = markers;
  useShortcut(combosOf("slice"), () => void sliceSelection(live.current, false));
  const ready = () => useEditStudio.getState().analysisState === "ready";
  const cmd = (id: string, title: string, run: Command["run"], extra: Partial<Command> = {}): Command => ({ id: `edit-studio.${id}`, title, section: "Edit Studio", run, ...extra });
  useCommands([
    cmd("autofill", "Auto-fill…", () => {
      const sel = useEditStudio.getState().selection;
      useEditStudio.getState().openDialog({ kind: "autofill", range: sel?.kind === "range" ? { fromMs: sel.fromMs, toMs: sel.toMs } : null });
    }, { icon: "wand-sparkles", enabled: ready }),
    cmd("markers-csv", "Export markers (CSV)", () => exportMarkers("csv"), { enabled: ready, keywords: ["beats", "csv"] }),
    cmd("markers-json", "Export markers (JSON)", () => exportMarkers("json"), { enabled: ready, keywords: ["beats", "json"] }),
    cmd("srt", "Export SRT", () => exportSrt(), { enabled: () => ready() && !!useEditStudio.getState().history?.present.captions, keywords: ["captions", "subtitles"] }),
    cmd("slice", "Slice at markers", () => void sliceSelection(live.current, false), { icon: "scissors", shortcut: "Shift+S", enabled: ready }),
    cmd("slice-cycle", "Slice and cycle sources", () => void sliceSelection(live.current, true), { icon: "scissors", enabled: ready }),
  ]);
}

export const MUSIC_EDIT_PROFILE: EditorProfile = {
  moduleId: "edit-studio",
  title: "Edit Studio",
  noun: "edit",
  song: "analyzed",
  homeFilter: "music-edit",
  markerSignals: true,

  HeaderStart: SongChip,
  HeaderEnd: AutofillButton,
  moreItems: ({ disabled, project }) => [
    { id: "markers-csv", label: "Export markers (CSV)", tip: "Save the beat, kick, snare and other marker times as a spreadsheet file", disabled, onSelect: () => void exportMarkers("csv") },
    { id: "markers-json", label: "Export markers (JSON)", tip: "Save the marker times as a JSON file for other software", disabled, onSelect: () => void exportMarkers("json") },
    { id: "srt", label: "Export captions (SRT)", tip: project.captions ? "Save the captions as an SRT subtitle file" : "Turn captions on first", disabled: disabled || !project.captions, onSelect: () => void exportSrt() },
  ],

  Setup: SetupPanel,
  TimelineTop,
  panels: MUSIC_PANELS,
  rail: ["media", "song", "markers", "captions", "style", "project"],
  songPanel: "song",
  markersPanel: "markers",
  clipChips: [{ panel: "clip-music", summary: (c) => (c.pinned ? "Pinned" : "") }],

  inspector: {
    SourceExtras: VelocityControl,
    PostExtras: HitOn,
  },
  TracksToolbar,
  TracksOverlay: MomentsOverlay,
  clipMenuItems: (clips, ctx) => {
    const markers = ctx?.markers ?? [];
    const st = useEditStudio.getState();
    const sources = st.history?.present.sources.length ?? 0;
    void clips;
    return [
      { id: "slice", label: `Slice at ${st.activeLane} markers`, icon: "scissors", tip: `Cut the selected clips at every ${st.activeLane} marker they cover`, onSelect: () => void sliceSelection(markers, false) },
      { id: "cycle", label: "Slice and cycle sources", icon: "scissors", tip: sources < 2 ? "Needs at least two sources in the Sources panel" : "Slice at the active lane's markers and give each piece the next source in turn", disabled: sources < 2, onSelect: () => void sliceSelection(markers, true) },
      { id: "style", label: "Style this part…", icon: "wand-sparkles", tip: "Choose what this part cuts on, which footage it uses and what it reacts to", onSelect: () => openStyleFromContext(markers) },
    ];
  },
  useSnapMarkers: useMarkers,

  Dialogs,
  useCommands: useMusicCommands,
};

