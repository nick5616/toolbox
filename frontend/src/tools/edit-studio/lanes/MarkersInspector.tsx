/** The Inspector for selected markers: what they are and how to change them. */
import { useMemo } from "react";
import { LANE_LABELS } from "@/editor/inspector/EditSignalSelect";
import styles from "@/editor/inspector/inspector.module.css";
import { useMarkers, useProject } from "@/editor/store";
import { formatClock } from "../song/SongInspector";

export function MarkersInspector({ ids }: { ids: string[] }) {
  const markers = useMarkers();
  const project = useProject();
  const picked = useMemo(() => {
    const set = new Set(ids);
    return markers.filter((m) => set.has(m.id));
  }, [markers, ids]);
  if (!project) return null;
  const first = picked[0];
  const title = picked.length === 1 && first ? (first.label || LANE_LABELS[first.lane]) : `${ids.length} markers selected`;
  return (
    <div className={styles.stack} aria-label="Markers inspector">
      <p className={styles.label}>{title}</p>
      {picked.length === 1 && first && (
        <div className={styles.row} data-tip="Where this marker is in the edit (minutes:seconds)">
          <span className={styles.label}>{LANE_LABELS[first.lane]}</span>
          <span className={styles.mono}>{formatClock(first.ms)}</span>
        </div>
      )}
      <p className={styles.hint}>Press Delete to remove the selected markers (a lane&apos;s settings can bring them back). M adds a custom marker at the playhead.</p>
    </div>
  );
}
