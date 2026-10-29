import { useCallback, useEffect, useRef, useState } from "react";
import { JobStatus, JobsService, SubtitlesService, type SubtitlesOptions } from "@/lib/api";
import { toAppError, type AppErrorShape } from "@/lib/errors";
import { isActive, useJob, type JobView } from "@/state/jobs";

export interface JobRun {
  /** The job being followed (latest started). */
  job: JobView | undefined;
  /** True from submit until the job finishes. */
  busy: boolean;
  /** A submit-time failure (validation, missing tool, …). */
  error: AppErrorShape | null;
  start: (inputs: string[], opts: SubtitlesOptions) => Promise<void>;
  cancel: () => void;
  /** Forgets the current job and error (hides the result card). */
  clear: () => void;
}

/**
 * Submits one Subtitles job and follows it through the jobs store.
 * `onDone` runs once when the job reaches `done`.
 */
export function useJobRun(onDone?: (job: JobView) => void): JobRun {
  const [id, setId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<AppErrorShape | null>(null);
  const job = useJob(id);
  const handled = useRef("");
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (job && job.status === JobStatus.JobDone && handled.current !== job.id) {
      handled.current = job.id;
      doneRef.current?.(job);
    }
  }, [job]);

  const start = useCallback(async (inputs: string[], opts: SubtitlesOptions) => {
    setError(null);
    setSubmitting(true);
    try {
      const jobs = await SubtitlesService.Enqueue(inputs, opts);
      const first = jobs?.[0];
      if (first) setId(first.id);
    } catch (e) {
      setError(toAppError(e));
    } finally {
      setSubmitting(false);
    }
  }, []);

  const cancel = useCallback(() => {
    if (id) JobsService.Cancel(id).catch(() => undefined);
  }, [id]);

  const clear = useCallback(() => {
    setId("");
    setError(null);
  }, []);

  return { job, busy: submitting || (job !== undefined && isActive(job)), error, start, cancel, clear };
}
