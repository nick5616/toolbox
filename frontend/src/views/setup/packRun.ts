import { JobStatus, PackState } from "@/lib/api";
import type { JobView } from "@/state/jobs";
import type { PackProgress, PackRunStatus } from "./PackCard";
import type { PackView } from "./packSizes";

/** Where a pack's install stands, from its newest install job (and the pack's own state). */
export function runStatus(pack: PackView, job: JobView | undefined): PackRunStatus {
  if (job) {
    switch (job.status) {
      case JobStatus.JobRunning:
        return "running";
      case JobStatus.JobDone:
        return "done";
      case JobStatus.JobFailed:
        return "failed";
      case JobStatus.JobCancelled:
        return "cancelled";
      default:
        return "waiting";
    }
  }
  return pack.state === PackState.PackInstalled ? "done" : "waiting";
}

export function isFinished(s: PackRunStatus): boolean {
  return s === "done" || s === "failed" || s === "cancelled";
}

/** Progress props for a PackCard, without the Cancel/Retry handlers. */
export function deriveProgress(pack: PackView, job: JobView | undefined): PackProgress {
  const status = runStatus(pack, job);
  return {
    status,
    value: job ? job.progress : 0,
    message: job?.message ?? "",
    error: job?.error || undefined,
    hint: job?.errorHint || undefined,
  };
}
