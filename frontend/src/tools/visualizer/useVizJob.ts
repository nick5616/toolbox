import { useCallback, useEffect, useRef, useState } from "react";
import { JobStatus, JobsService, VisualizerService, type VisualizerOptions, type VisualizerResult } from "@/lib/api";
import { toAppError, type AppErrorShape } from "@/lib/errors";
import { isActive, useJob, type JobView } from "@/state/jobs";

export interface VizJob {
  job: JobView | undefined;
  busy: boolean;
  error: AppErrorShape | null;
  start(inputs: string[], opts: VisualizerOptions): Promise<void>;
  cancel(): void;
  clear(): void;
}

/** Submits one Visualizer job and follows it; `onDone` runs once when it finishes. */
export function useVizJob(onDone?: (job: JobView) => void): VizJob {
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

  const start = useCallback(async (inputs: string[], opts: VisualizerOptions) => {
    setError(null);
    setSubmitting(true);
    try {
      const jobs = await VisualizerService.Enqueue(inputs, opts);
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

export function parseVizResult(json: string): VisualizerResult | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as VisualizerResult;
  } catch {
    return null;
  }
}

/** Live speed of a running render: output frames per second and media seconds per wall second. */
export function liveSpeed(progress: number, startedAtMs: number, nowMs: number, rangeSec: number, outFps: number): { fps: number; times: number } | null {
  const elapsed = (nowMs - startedAtMs) / 1000;
  if (!(progress > 0.02) || !(elapsed > 1) || startedAtMs <= 0) return null;
  const rendered = Math.min(1, progress / 0.9) * rangeSec;
  const times = rendered / elapsed;
  return { fps: times * outFps, times };
}
