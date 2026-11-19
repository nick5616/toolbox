/**
 * "Preparing" progress of a clip's source (Phase 21 SPEC B5). A project has at
 * most one prepare job (`jobs.prepare`, covering every source that has no edit
 * stream yet), so the progress of a clip is that job's progress while the
 * clip's own source is still waiting for its preview stream.
 */
import { useEditStudio } from "@/editor/store";
import { useJob } from "@/state/jobs";

/** Pure: the progress to show for a source, or null when it isn't being prepared. */
export function prepareProgressOf(sourceReady: boolean, job: { status: string; progress: number } | undefined): number | null {
  if (sourceReady || !job) return null;
  if (job.status !== "running" && job.status !== "queued") return null;
  return job.status === "queued" ? -1 : job.progress;
}

/**
 * 0..1 while the source at `path` is being prepared, -1 when it's waiting or
 * indeterminate, null when it isn't being prepared (ready or no job). Selects
 * narrowly: only this job's progress re-renders the caller.
 */
export function usePrepareProgress(path: string): number | null {
  const ready = useEditStudio((s) => !!s.sources[path]?.preview);
  const jobId = useEditStudio((s) => s.jobs.prepare);
  const job = useJob(jobId ?? "");
  return prepareProgressOf(ready, job ? { status: job.status, progress: job.progress } : undefined);
}
