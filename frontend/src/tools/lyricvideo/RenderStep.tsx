import { Banner, Button, Section, Slider } from "@/components";
import { JobStatus } from "@/lib/api";
import { MediaPlayer, formatMs, useMediaSource } from "@/components/media";
import { DepsGate } from "@/tools/_kit";
import { RunStatus } from "./RunStatus";
import type { JobRun } from "./useJobRun";
import styles from "./LyricVideoView.module.css";

export interface RenderStepProps {
  moduleId: string;
  durationMs: number;
  previewStartMs: number;
  onPreviewStart: (ms: number) => void;
  blocker: string;
  engineBlocked: boolean;
  /** Instrumental audio will be made on the engine if it isn't cached. */
  instrumental: boolean;
  /** Missing background file / cover warnings. */
  warning: string;
  preview: JobRun;
  previewPath: string;
  render: JobRun;
  onPreview: () => void;
  onRender: () => void;
}

/** The exact rendered preview clip, played back in a video player. */
function PreviewClip({ path }: { path: string }) {
  const media = useMediaSource(path);
  if (media.status === "error") {
    return (
      <Banner tone="danger" title={media.error?.message ?? "Couldn't open the preview"} action={<Button size="sm" onClick={media.retry}>Try again</Button>}>
        {media.error?.hint}
      </Banner>
    );
  }
  if (media.status !== "ready" || !media.source) return <div className={styles.muted}>Opening the preview…</div>;
  return <MediaPlayer source={media.source} kind="video" className={styles.clip} />;
}

/** Step 4: render a 10 s preview, then the whole video. */
export function RenderStep(p: RenderStepProps) {
  const maxStart = Math.max(0, p.durationMs - 1000);
  const busy = p.preview.busy || p.render.busy;
  const gated = !!p.blocker || (p.instrumental && p.engineBlocked);
  return (
    <div className={styles.renderBody}>
      {p.blocker && <Banner tone="danger" title={p.blocker} />}
      {p.warning && <Banner tone="warn" title={p.warning} />}
      {p.instrumental && <DepsGate moduleId={p.moduleId} />}

      <Section label="Preview">
        <div className={styles.form}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Starts at {formatMs(p.previewStartMs)}</span>
            <Slider
              aria-label="Preview start"
              min={0}
              max={maxStart}
              step={500}
              value={Math.min(p.previewStartMs, maxStart)}
              onChange={p.onPreviewStart}
              format={formatMs}
            />
          </label>
          <div className={styles.buttonRow}>
            <Button icon="play" variant="secondary" onClick={p.onPreview} loading={p.preview.busy} disabled={gated || busy}>
              Render 10 s preview
            </Button>
          </div>
          <RunStatus run={p.preview} runningLabel="Rendering the preview…" showResult={false} />
          {p.previewPath && p.preview.job?.status === JobStatus.JobDone && <PreviewClip key={p.previewPath} path={p.previewPath} />}
        </div>
      </Section>

      <Section label="Video">
        <div className={styles.form}>
          <div className={styles.buttonRow}>
            <Button icon="film" onClick={p.onRender} loading={p.render.busy} disabled={gated || busy}>
              Render video
            </Button>
            <span className={styles.muted}>Also saves the timings as a .lrc file.</span>
          </div>
          <RunStatus run={p.render} runningLabel="Rendering the video…" doneLabel="Your lyric video is ready" />
        </div>
      </Section>
    </div>
  );
}
