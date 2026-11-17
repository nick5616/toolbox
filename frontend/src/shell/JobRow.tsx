// Used by the job tray and by tool views (e.g. the downloader's "Active" list).
import { memo, useEffect, useState } from "react";
import { JobStatus, LibraryService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { formatElapsed, formatRelativeTime } from "@/lib/format";
import { revealLabel } from "@/lib/platform";
import { Icon, IconButton, Meter, StatusChip, toast, cx, type ChipStatus } from "@/components";
import { isActive, useJobs, type JobView } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
// --- pipelines ---
import { usePipelines } from "@/state/pipelines";
// --- end pipelines ---
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

/** Memoised: job objects keep their identity while unchanged. */
export const JobRow = memo(function JobRow({ job, compact = false }: JobRowProps) {
  const icon = useModules((s) => s.byId[job.moduleId]?.icon ?? "box");
  const expanded = useUI((s) => s.expandedLogJobId === job.id);
  const setExpanded = useUI((s) => s.setExpandedLogJobId);
  const active = isActive(job);
  const running = job.status === JobStatus.JobRunning;
  const now = useNow(running);

  // --- pipelines ---
  const pipelineRun = usePipelines((st) => (job.pipelineRunId ? st.runs[job.pipelineRunId] : undefined));
  // --- end pipelines ---

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
        <span className={styles.icon} data-tip="The tool running this job">
          <Icon name={icon} size={16} />
        </span>
        <span className={styles.title} title={title}>
          {title}
        </span>
        {/* --- pipelines --- */}
        {job.pipelineRunId && (
          <button
            type="button"
            className={styles.runChip}
            data-tip="Open the pipeline run this job belongs to"
            onClick={() => {
              useUI.getState().navigate("pipelines");
              usePipelines.getState().showRun(job.pipelineRunId);
            }}
          >
            {`⛓ ${pipelineRun?.name || "Pipeline"}${
              pipelineRun && pipelineRun.steps.length > 0
                ? ` · ${pipelineRun.steps.findIndex((x) => x.id === job.pipelineStepId) + 1}/${pipelineRun.steps.length}`
                : ""
            }`}
          </button>
        )}
        {/* --- end pipelines --- */}
        <StatusChip status={status} />
        <Meter tip="Progress of this job" className={styles.meter} value={job.progress} status={status} size="sm" label={`Progress: ${title}`} />
        <span className={styles.message} title={message}>
          {message}
        </span>
        <span className={styles.time} data-tip={running ? "Time since it started" : "When it finished"}>{time}</span>
        <span className={styles.actions}>
          {active && (
            <IconButton
              size="sm"
              icon="x"
              label="Cancel"
              data-tip={job.cancelRequested ? "Already stopping" : "Stop this job; partly made files are cleaned up"}
              disabled={job.cancelRequested}
              onClick={run(() => useJobs.getState().cancel(job.id))}
            />
          )}
          {canRetry && (
            <IconButton size="sm" icon="rotate-ccw" label="Retry" data-tip="Run this job again with the same settings" onClick={run(() => useJobs.getState().retry(job.id))} />
          )}
          {job.status === JobStatus.JobDone && firstOutput && (
            <IconButton
              size="sm"
              icon="folder-open"
              label={revealLabel}
              data-tip="Show the finished file in your file manager"
              onClick={run(() => LibraryService.Reveal(firstOutput.id))}
            />
          )}
          {!compact && !active && (
            <IconButton
              size="sm"
              icon="trash-2"
              label="Remove"
              data-tip="Remove this job from the list (the files it made stay in your library)"
              className={styles.remove}
              onClick={run(() => useJobs.getState().remove(job.id))}
            />
          )}
          {!compact && (
            <IconButton
              size="sm"
              icon={expanded ? "chevron-up" : "chevron-down"}
              label={expanded ? "Hide log" : "Show log"}
              data-tip={expanded ? "Hide the technical output of this job" : "Show the technical output of this job, useful when something fails"}
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
});
