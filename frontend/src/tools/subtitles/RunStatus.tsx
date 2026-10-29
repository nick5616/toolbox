import { Banner, Button, IconButton, Icon, Meter } from "@/components";
import { JobStatus } from "@/lib/api";
import { copyText } from "@/lib/copy";
import { FileActions } from "@/tools/_kit/FileActions";
import { basename } from "./logic";
import { parseResult } from "./options";
import type { JobRun } from "./useJobRun";
import styles from "./SubtitlesView.module.css";

export interface RunStatusProps {
  run: JobRun;
  /** Shown above the meter while running ("Burning subtitles…"). */
  runningLabel: string;
  /** Show the result card when the job is done. */
  showResult?: boolean;
  /** Label for the result card title. */
  doneLabel?: string;
  onOpenChat?: () => void;
}

function mentionsChat(...texts: Array<string | undefined>): boolean {
  return texts.some((t) => t !== undefined && /local chat/i.test(t));
}

/** Inline progress, failure and result for one Subtitles job. */
export function RunStatus({ run, runningLabel, showResult = true, doneLabel = "Done", onOpenChat }: RunStatusProps) {
  const { job, error } = run;
  const chatAction = (hint: string | undefined, message: string | undefined) =>
    onOpenChat && mentionsChat(hint, message) ? (
      <Button size="sm" variant="secondary" onClick={onOpenChat}>
        Open Local Chat
      </Button>
    ) : undefined;

  if (error) {
    return (
      <Banner tone="danger" title={error.message} action={chatAction(error.hint, error.message)}>
        {error.hint}
      </Banner>
    );
  }
  if (!job) return null;

  if (job.status === JobStatus.JobQueued || job.status === JobStatus.JobRunning) {
    const queued = job.status === JobStatus.JobQueued;
    return (
      <div className={styles.runBox} role="status" aria-live="polite">
        <div className={styles.runHead}>
          <span>{queued ? "Waiting to start…" : runningLabel}</span>
          <Button size="sm" variant="ghost" onClick={run.cancel}>
            Cancel
          </Button>
        </div>
        <Meter value={queued ? 0 : job.progress} status={queued ? "queued" : "running"} label={runningLabel} />
        {job.message && <div className={styles.runMsg}>{job.message}</div>}
      </div>
    );
  }
  if (job.status === JobStatus.JobFailed) {
    return (
      <Banner tone="danger" title={job.error || "That didn't work"} action={chatAction(job.errorHint, job.error)}>
        {job.errorHint}
      </Banner>
    );
  }
  if (job.status === JobStatus.JobCancelled) {
    return <Banner tone="info" title="Cancelled" />;
  }
  if (job.status === JobStatus.JobDone && showResult) {
    const result = parseResult(job.resultJson);
    const outputs = result?.outputs?.length ? result.outputs : job.outputs.map((o) => o.path);
    return (
      <div className={styles.resultCard} aria-label="Result">
        <div className={styles.resultHead}>
          <Icon name="check" size={14} />
          <span>{doneLabel}</span>
        </div>
        <ul className={styles.resultList}>
          {outputs.map((path) => {
            const out = job.outputs.find((o) => o.path === path);
            return (
              <li key={path} className={styles.resultRow}>
                <span className={styles.resultName} title={path}>
                  {basename(path)}
                </span>
                <FileActions outputId={out?.id} path={path} disabled={out?.missing} />
                <IconButton size="sm" icon="copy" label="Copy path" onClick={() => void copyText(path, { what: "path" })} />
              </li>
            );
          })}
        </ul>
      </div>
    );
  }
  return null;
}
