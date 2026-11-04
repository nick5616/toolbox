/** The Inspector (§14.8): follows the selection. Props are frozen (none). */
import { Switch } from "@/components";
import { findClip, withClip } from "../doc";
import { useEditStudio, useProject } from "../store";
import { AdjustInspector } from "./AdjustInspector";
import { ClipInspector } from "./ClipInspector";
import { editDoc } from "./inspectorState";
import { ProjectInspector } from "./ProjectInspector";
import { SongInspector } from "./SongInspector";
import { TrackInspector } from "./TrackInspector";
import styles from "./inspector.module.css";

export function InspectorPanel() {
  const project = useProject();
  const selection = useEditStudio((s) => s.selection);
  if (!project) return null;

  if (selection?.kind === "clips" && selection.ids.length > 0) {
    if (selection.ids.length === 1) {
      const ref = findClip(project, selection.ids[0] as string);
      if (ref) return ref.clip.kind === "adjust" ? <AdjustInspector key={ref.clip.id} clip={ref.clip} /> : <ClipInspector key={ref.clip.id} clip={ref.clip} />;
    } else {
      const ids = selection.ids;
      const clips = ids.map((id) => findClip(project, id)?.clip).filter((c): c is NonNullable<typeof c> => !!c);
      const allPinned = clips.length > 0 && clips.every((c) => c.pinned);
      return (
        <div className={styles.root} aria-label="Clips inspector">
          <div className={styles.head}>
            <h2 className={styles.title}>{`${clips.length} clips selected`}</h2>
          </div>
          <Switch
            tip="Keep all selected clips as they are when Auto-fill rebuilds the edit"
            label="Pinned"
            checked={allPinned}
            onChange={(pinned) => editDoc((p) => ids.reduce((acc, id) => withClip(acc, id, { pinned }), p))}
          />
          <p className={styles.hint}>Select one clip to edit its source, transform, effects and masks.</p>
        </div>
      );
    }
  }
  if (selection?.kind === "track") {
    const track = project.tracks.find((t) => t.id === selection.id);
    if (track) return <TrackInspector key={track.id} track={track} />;
  }
  if (selection?.kind === "song") return <SongInspector />;
  return <ProjectInspector />;
}
