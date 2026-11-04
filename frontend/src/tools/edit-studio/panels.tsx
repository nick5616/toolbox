/**
 * Edit Studio's panels (Phase 10 SPEC §5.5): the music layer's constituents,
 * each a click-in in the rail or the selection bar and poppable into its own
 * window. They read only the editor store and the profile context.
 */
import { Button, Section, Select, Stepper, Switch } from "@/components";
import { laneSettings } from "@/viz/edit/defaults";
import { MARKER_LANES, type MarkerLane } from "@/viz/edit/types";
import { editDoc } from "@/editor/inspector/inspectorState";
import styles from "@/editor/inspector/inspector.module.css";
import { LANE_LABELS as EDITOR_LANE_LABELS } from "@/editor/inspector/EditSignalSelect";
import { registerEditorPanel } from "@/editor/panels";
import { useEditStudio, useMarkers, useProject } from "@/editor/store";
import { useSelectedClip } from "@/editor/inspector/clipPanels";
import { patchClip } from "@/editor/inspector/inspectorState";
import { CaptionsPanel } from "./captions/CaptionsPanel";
import { LANE_LABELS, withLane } from "./lanes/laneLogic";
import { MarkersInspector } from "./lanes/MarkersInspector";
import { MomentsSection } from "./moments/MomentsSection";
import { openStyleFromContext } from "./sectionstyle/useSectionStyle";
import { cutOffsetText, SongInspector } from "./song/SongInspector";

/** Markers: the active lane, how many lanes show, the cut offset, and what is selected. */
function MarkersPanel() {
  const project = useProject();
  const activeLane = useEditStudio((s) => s.activeLane);
  const selection = useEditStudio((s) => s.selection);
  if (!project) return null;
  const shown = MARKER_LANES.filter((l) => laneSettings(project.markers, l).visible);
  const laneOptions = (shown.includes(activeLane) ? shown : MARKER_LANES.filter((l) => l === activeLane || shown.includes(l))).map((l) => ({ value: l, label: EDITOR_LANE_LABELS[l] }));
  return (
    <div className={styles.root} aria-label="Markers">
      <Section label="Active lane" tip="The marker lane that Snap, marker jumps, Slice and Cut to beat follow">
        <div className={styles.row} data-tip="The marker lane that Snap, marker jumps, Slice and Cut to beat follow">
          <span className={styles.label}>Lane</span>
          <Select<MarkerLane> size="sm" aria-label="Active lane" value={activeLane} options={laneOptions} onChange={(l) => useEditStudio.getState().setActiveLane(l)} />
        </div>
      </Section>
      <Section label="Cut timing" tip="Nudge every beat-synced cut a few frames earlier or later">
        <div className={styles.stack}>
          <div className={styles.row} data-tip="Shift every beat-synced cut earlier or later by this many frames (-3 to 3), to feel tighter on the music">
            <span className={styles.label}>Cut offset</span>
            <Stepper aria-label="Cut offset in frames" value={project.cutOffsetFrames} min={-3} max={3} onChange={(v) => editDoc((p) => ({ ...p, cutOffsetFrames: Math.max(-3, Math.min(3, Math.round(v))) }), "cut-offset")} />
          </div>
          <p className={styles.hint}>{cutOffsetText(project.cutOffsetFrames)}</p>
        </div>
      </Section>
      <Section label="Lanes shown" tip="Which marker lanes appear above the timeline">
        <div className={styles.stack}>
          {MARKER_LANES.map((l) => (
            <Switch key={l} label={LANE_LABELS[l]} tip={`Show or hide the ${LANE_LABELS[l].toLowerCase()} lane`} checked={laneSettings(project.markers, l).visible} onChange={(visible) => editDoc((p) => withLane(p, l, { visible }), `lane:${l}:visible`)} />
          ))}
          <p className={styles.hint}>Each lane&apos;s threshold, every-Nth and nudge are under its ⋯ button in the lane.</p>
        </div>
      </Section>
      {selection?.kind === "markers" && <MarkerSelection ids={selection.ids} />}
    </div>
  );
}

function MarkerSelection({ ids }: { ids: string[] }) {
  return (
    <Section label="Selected">
      <MarkersInspector ids={ids} />
    </Section>
  );
}

/** Style: styling a part of the song (the Section style dialog). */
function StylePanel() {
  const markers = useMarkers();
  return (
    <div className={styles.root} aria-label="Style">
      <p className={styles.hint}>Style a part of the song: what it cuts on, which footage it uses and what it reacts to. It uses the selection, else the section at the playhead.</p>
      <Button icon="wand-sparkles" data-tip="Choose what this part cuts on, which footage it uses and what it reacts to" onClick={() => openStyleFromContext(markers)}>
        Style this part…
      </Button>
    </div>
  );
}

/** Auto-fill and moments for the selected clip. */
function ClipMusicPanel() {
  const clip = useSelectedClip();
  if (!clip) return <p className={styles.empty}>Select one clip on the timeline to see how the music treats it.</p>;
  return <ClipMusic key={clip.id} clip={clip} />;
}

function ClipMusic({ clip }: { clip: NonNullable<ReturnType<typeof useSelectedClip>> }) {
  return (
    <div className={styles.root} aria-label="Clip and music">
      <Section label="Auto-fill" tip="Controls how Auto-fill treats this clip">
        <Switch tip="Keep this clip as it is when Auto-fill rebuilds the edit" label="Pinned" checked={clip.pinned} onChange={(pinned) => patchClip(clip.id, { pinned }, "")} />
        <p className={styles.hint}>Auto-fill never moves, replaces or removes a pinned clip.</p>
      </Section>
      {clip.kind === "video" && <MomentsSection clip={clip} />}
    </div>
  );
}

registerEditorPanel({ id: "song", title: "Song", icon: "music", tip: "The song: its range, analysis, volume and fades", component: SongInspector });
registerEditorPanel({ id: "markers", title: "Markers", icon: "activity", tip: "Active lane, cut offset and which marker lanes show", component: MarkersPanel });
registerEditorPanel({ id: "captions", title: "Captions", icon: "captions", tip: "Words from the song shown on the picture as captions", component: CaptionsPanel, width: 440 });
registerEditorPanel({ id: "style", title: "Style", icon: "wand-sparkles", tip: "Style a part of the song: cuts, footage and reactions", component: StylePanel });
registerEditorPanel({ id: "clip-music", title: "Auto-fill", icon: "wand-sparkles", tip: "Pin the selected clip and see its moments", component: ClipMusicPanel });
