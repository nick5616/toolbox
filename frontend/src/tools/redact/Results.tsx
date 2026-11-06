import { Banner, Button } from "@/components";
import { MediaPlayer, useMediaSource } from "@/components/media";
import type { JobView } from "@/state/jobs";
import { FileActions } from "@/tools/_kit/FileActions";
import { useResultBehaviour } from "@/tools/_kit/ResultRow";
import { formatBytes } from "@/lib/format";
import { Thumb } from "./bits";
import { baseName, isVideoPath } from "./logic";
import styles from "./RedactView.module.css";

function VideoResult({ path }: { path: string }) {
  const media = useMediaSource(path);
  if (media.status === "ready" && media.source) {
    return <MediaPlayer className={styles.resultPlayer} source={media.source} kind="video" path={path} />;
  }
  if (media.status === "error") {
    return (
      <Banner tone="warn" title={media.error?.message ?? "This video can't be played here"}>
        {media.error?.hint}
      </Banner>
    );
  }
  return (
    <span className={styles.hint} role="status">
      {media.status === "preparing" ? "Preparing a preview copy…" : "Loading…"}
    </span>
  );
}

function ResultCard({ o }: { o: JobView["outputs"][number] }) {
  const { draggable, onDragStart, onDoubleClick, ...behaviour } = useResultBehaviour({ path: o.path, outputId: o.id || undefined, missing: o.missing });
  // Only the footer starts a drag or opens the file: the player keeps its own drags.
  const grip = { draggable, onDragStart, onDoubleClick };
  return (
    <li {...behaviour} className={styles.card} data-testid="result-card">
    {isVideoPath(o.path) ? <VideoResult path={o.path} /> : <Thumb path={o.path} size={480} className={styles.cardThumb} />}
    <div className={styles.cardFoot} {...grip}>
      <span className={styles.cardName} data-tip={o.path}>
        {o.name || baseName(o.path)}
      </span>
      <span className={styles.hint} data-tip="File size on disk">
        {formatBytes(o.sizeBytes)}
      </span>
      <FileActions outputId={o.id} path={o.path} disabled={o.missing} />
    </div>
</li>
  );
}

export interface ResultsProps {
  job: JobView;
  /** Back to the boxes (only when there are detections to edit). */
  onEdit?: () => void;
  onMore: () => void;
}

/** The cards alone (no banner, no footer): one per redacted file. */
export function ResultCards({ outputs }: { outputs: JobView["outputs"] }) {
  return (
    <ul className={styles.cards}>
      {outputs.map((o) => (
        <ResultCard key={o.id || o.path} o={o} />
      ))}
    </ul>
  );
}

/** Cards for the redacted files with Reveal/Open and a reminder to check them. */
export function Results({ job, onEdit, onMore }: ResultsProps) {
  const outputs = job.outputs;
  return (
    <div className={styles.results} aria-label="Redacted files">
      <Banner tone="info" title={`${outputs.length === 1 ? "Redacted copy saved" : `${outputs.length} redacted copies saved`}`}>
        The originals are untouched. Look over each result before sharing it.
      </Banner>
      <ResultCards outputs={outputs} />
      <div className={styles.footer}>
        <span className={styles.spacer} />
        {onEdit && (
          <Button variant="secondary" data-tip="Go back to the boxes, change them and save again" onClick={onEdit}>
            Edit the boxes again
          </Button>
        )}
        <Button variant="primary" icon="scan-face" data-tip="Clear this session and pick new files to redact" onClick={onMore}>
          Redact more
        </Button>
      </div>
    </div>
  );
}
