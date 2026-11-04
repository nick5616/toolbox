import { useMemo } from "react";
import type { AppErrorShape } from "@/lib/errors";
import { isActive, useJob, type JobView } from "@/state/jobs";
import { useSubtitles, type RunKey } from "./store";

/** One Subtitles job as the panels show it (the job itself lives in the jobs store; the id in this tool's store). */
export interface JobRun {
  /** The job being followed (latest started). */
  job: JobView | undefined;
  /** True from submit until the job finishes. */
  busy: boolean;
  /** A submit-time failure (validation, missing tool, …). */
  error: AppErrorShape | null;
  cancel: () => void;
  /** Forgets the current job and error (hides the result card). */
  clear: () => void;
}

export function useRun(key: RunKey): JobRun {
  const run = useSubtitles((s) => s.runs[key]);
  const cancelRun = useSubtitles((s) => s.cancelRun);
  const clearRun = useSubtitles((s) => s.clearRun);
  const job = useJob(run.jobId);
  return useMemo(
    () => ({
      job,
      busy: run.submitting || (job !== undefined && isActive(job)),
      error: run.error,
      cancel: () => cancelRun(key),
      clear: () => clearRun(key),
    }),
    [job, run.submitting, run.error, cancelRun, clearRun, key],
  );
}
