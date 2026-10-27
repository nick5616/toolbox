// Used by the job tray and by tool views (e.g. the downloader's "Active" list).
import { useEffect, useState } from "react";
import { JobStatus, LibraryService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { formatElapsed, formatRelativeTime } from "@/lib/format";
import { revealLabel } from "@/lib/platform";
import { Icon, IconButton, Meter, StatusChip, toast, cx, type ChipStatus } from "@/components";
import { isActive, useJobs, type JobView } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { LogPanel } from "./LogPanel";
import styles from "./JobRow.module.css";

export interface JobRowProps {
  job: JobView;
  /** Compact variant for tool views: no log toggle, no remove action. */
  compact?: boolean;
}

function report(e: unknown): void {
  toast({ tone: "danger", title: toAppError(e).message });
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function JobRow({ job, compact = false }: JobRowProps) {
  const icon = useModules((s) => s.byId[job.moduleId]?.icon ?? "box");
  const expanded = useUI((s) => s.expandedLogJobId === job.id);
  const setExpanded = useUI((s) => s.setExpandedLogJobId);
  const active = isActive(job);
  const running = job.status === JobStatus.JobRunning;
  const now = useNow(running);

  const status = job.status as ChipStatus;
  const title = job.title || job.inputs[0] || job.id;
  const firstOutput = job.outputs[0];
  const canRetry = job.status === JobStatus.JobFailed || job.status === JobStatus.JobCancelled;

  let message = job.message;
  if (job.cancelRequested && active) message = "Cancelling…";
  else if (job.status === JobStatus.JobFailed) message = "";

  let time = "";
  if (running && job.startedAt) time = formatElapsed(job.startedAt, now);
  else if (!active && job.finishedAt) time = formatRelativeTime(job.finishedAt, now);

  const run = (fn: () => Promise<unknown>) => () => {
    fn().catch(report);
  };

  return (
    <div className={cx(styles.wrap, compact && styles.compact)} data-status={job.status}>
      <div className={styles.row}>
        <span className={styles.icon}>
          <Icon name={icon} size={16} />
        </span>
        <span className={styles.title} title={title}>
          {title}
        </span>
        <StatusChip status={status} />
        <Meter className={styles.meter} value={job.progress} status={status} size="sm" label={`Progress: ${title}`} />
        <span className={styles.message} title={message}>
          {message}
        </span>
        <span className={styles.time}>{time}</span>
        <span className={styles.actions}>
          {active && (
            <IconButton
              size="sm"
              icon="x"
              label="Cancel"
              disabled={job.cancelRequested}
              onClick={run(() => useJobs.getState().cancel(job.id))}
            />
          )}
          {canRetry && (
            <IconButton size="sm" icon="rotate-ccw" label="Retry" onClick={run(() => useJobs.getState().retry(job.id))} />
          )}
          {job.status === JobStatus.JobDone && firstOutput && (
            <IconButton
              size="sm"
              icon="folder-open"
              label={revealLabel}
              onClick={run(() => LibraryService.Reveal(firstOutput.id))}
            />
          )}
          {!compact && !active && (
            <IconButton
              size="sm"
              icon="trash-2"
              label="Remove"
              className={styles.remove}
              onClick={run(() => useJobs.getState().remove(job.id))}
            />
          )}
          {!compact && (
            <IconButton
              size="sm"
              icon={expanded ? "chevron-up" : "chevron-down"}
              label={expanded ? "Hide log" : "Show log"}
              pressed={expanded}
              onClick={() => setExpanded(expanded ? null : job.id)}
            />
          )}
        </span>
      </div>
      {job.status === JobStatus.JobFailed && (job.error || job.errorHint) && (
        <div className={styles.error}>
          {job.error && <div className={styles.errorMsg}>{job.error}</div>}
          {job.errorHint && <div className={styles.errorHint}>{job.errorHint}</div>}
        </div>
      )}
      {!compact && expanded && <LogPanel jobId={job.id} />}
    </div>
  );
}
