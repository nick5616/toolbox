import { useCallback } from "react";
import { JobsService, LyricVideoService, type LyricVideoOptions } from "@/lib/api";
import { toAppError, type AppErrorShape } from "@/lib/errors";
import { isActive, useJob, type JobView } from "@/state/jobs";
import { useLyricVideo, type JobSlot } from "./store";

export interface JobRun {
  job: JobView | undefined;
  /** True from submit until the job finishes. */
  busy: boolean;
  /** A submit-time failure (validation, missing tool, …). */
  error: AppErrorShape | null;
  start: (inputs: string[], opts: LyricVideoOptions) => Promise<void>;
  cancel: () => void;
  /** Forgets the current job and error (hides the result card). */
  clear: () => void;
}

/**
 * One Lyric Video job slot ("gen", "lrc", "preview", "render"), kept in the
 * store so a panel that closes and opens again still shows its job.
 */
export function useJobRun(slot: JobSlot): JobRun {
  const id = useLyricVideo((s) => s.jobIds[slot]);
  const submitting = useLyricVideo((s) => s.submitting[slot]);
  const error = useLyricVideo((s) => s.jobErrors[slot]);
  const job = useJob(id);

  const start = useCallback(
    async (inputs: string[], opts: LyricVideoOptions) => {
      const st = useLyricVideo.getState();
      st.setJobError(slot, null);
      st.setSubmitting(slot, true);
      try {
        const jobs = await LyricVideoService.Enqueue(inputs, opts);
        const first = jobs?.[0];
        if (first) useLyricVideo.getState().setJob(slot, first.id);
      } catch (e) {
        useLyricVideo.getState().setJobError(slot, toAppError(e));
      } finally {
        useLyricVideo.getState().setSubmitting(slot, false);
      }
    },
    [slot],
  );

  const cancel = useCallback(() => {
    if (id) JobsService.Cancel(id).catch(() => undefined);
  }, [id]);

  const clear = useCallback(() => {
    const st = useLyricVideo.getState();
    st.setJob(slot, "");
    st.setJobError(slot, null);
  }, [slot]);

  return { job, busy: submitting || (job !== undefined && isActive(job)), error, start, cancel, clear };
}

