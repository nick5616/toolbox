/**
 * Picks the song range of the open edit (§14.2): the range picker with
 * "Keep clips on the music" and Use this range. Reused by the Song inspector
 * ("Change range…").
 */
import { useState } from "react";
import { Button, Switch, toast } from "@/components";
import { useEditStudio, useProject } from "../store";
import { RangePicker } from "./RangePicker";
import { changeRange } from "./rangeLogic";
import styles from "./Setup.module.css";

export interface RangeEditorProps {
  /** Called after the range was applied. */
  onDone?: () => void;
}

export function RangeEditor({ onDone }: RangeEditorProps) {
  const project = useProject();
  const analysis = useEditStudio((s) => s.analysis);
  const [keep, setKeep] = useState(true);
  const [draft, setDraft] = useState<{ startMs: number; endMs: number } | null>(null);
  if (!project?.song || !analysis) return null;
  const song = project.song;
  const value = draft ?? { startMs: song.startMs, endMs: song.endMs };
  const hasClips = project.tracks.some((t) => t.clips.length > 0);
  const moves = value.startMs !== song.startMs;

  const apply = () => {
    const p = useEditStudio.getState().history?.present;
    if (!p) return;
    const r = changeRange(p, value, keep);
    if (r.project !== p) useEditStudio.getState().edit(r.project);
    if (r.removed > 0) toast({ title: r.removed === 1 ? "1 clip was removed" : `${r.removed} clips were removed`, description: "They ended before the new start. Undo brings them back.", tone: "warn" });
    setDraft(null);
    onDone?.();
  };

  return (
    <div className={styles.group}>
      <RangePicker analysis={analysis} songPath={song.path} value={value} onChange={setDraft} barOffset={project.markers.barOffset} />
      <div className={styles.row}>
        {hasClips && moves && <Switch label="Keep clips on the music" checked={keep} onChange={setKeep} />}
        <span className={styles.spacer} />
        <Button variant="primary" onClick={apply}>
          Use this range
        </Button>
      </div>
    </div>
  );
}
