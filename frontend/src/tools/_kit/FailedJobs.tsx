import { useMemo } from "react";
import { create } from "zustand";
import { IconButton, Icon, toast } from "@/components";
import { JobStatus } from "@/lib/api";
import { displayText } from "@/lib/displayPath";
import { toAppError } from "@/lib/errors";
import { useJobs, type JobView } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { useToolJobs } from "./session";
import styles from "./results.module.css";

/** When this page of the app started: older failures from the database aren't "this session's". */
const SESSION_START = Date.now();

interface DismissedState {
  ids: ReadonlySet<string>;
  dismiss: (id: string) => void;
  reset: () => void;
}

export const useDismissedJobs = create<DismissedState>((set) => ({
  ids: new Set(),
  dismiss: (id) => set((s) => ({ ids: new Set(s.ids).add(id) })),
  reset: () => set({ ids: new Set() }),
}));

/** Failed or cancelled jobs of a tool from this session that haven't been dismissed. */
export function useFailedJobs(moduleId: string): JobView[] {
  const jobs = useToolJobs(moduleId);
  const dismissed = useDismissedJobs((s) => s.ids);
  return useMemo(
    () => jobs.filter((j) => (j.status === JobStatus.JobFailed || j.status === JobStatus.JobCancelled) && (j.finishedAt || 0) >= SESSION_START && !dismissed.has(j.id)),
    [jobs, dismissed],
  );
}

function FailedRow({ job }: { job: JobView }) {
  const icon = useModules((s) => s.byId[job.moduleId]?.icon ?? "box");
  const dismiss = useDismissedJobs((s) => s.dismiss);
  const cancelled = job.status === JobStatus.JobCancelled;
  const title = job.title || job.inputs[0] || job.id;
  return (
    <div className={styles.failed} role="alert" data-status={job.status}>
      <Icon name={icon} size={16} />
      <div className={styles.failedBody}>
        <div className={styles.failedTitle} title={displayText(title)}>
          {displayText(title)}
        </div>
        <div className={styles.failedMsg}>{cancelled ? "Cancelled" : displayText(job.error || "Failed")}</div>
        {!cancelled && job.errorHint && <div className={styles.failedHint}>{displayText(job.errorHint)}</div>}
      </div>
      <IconButton
        size="sm"
        icon="rotate-ccw"
        label="Retry"
        data-tip="Run this job again with the same settings"
        onClick={() => {
          useJobs
            .getState()
            .retry(job.id)
            .catch((e: unknown) => toast({ tone: "danger", title: toAppError(e).message }));
        }}
      />
      <IconButton size="sm" icon="x" label="Dismiss" data-tip="Hide this until it happens again" onClick={() => dismiss(job.id)} />
    </div>
  );
}

/**
 * This session's failed and cancelled jobs for a tool, as compact rows with
 * the error, Retry and Dismiss. They stay on the page until dismissed.
 */
export function FailedJobs({ moduleId }: { moduleId: string }) {
  const failed = useFailedJobs(moduleId);
  if (failed.length === 0) return null;
  return (
    <div className={styles.failedList} aria-label="Failed jobs">
      {failed.map((j) => (
        <FailedRow key={j.id} job={j} />
      ))}
    </div>
  );
}
