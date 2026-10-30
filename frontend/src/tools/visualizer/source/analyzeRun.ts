/**
 * Runs one Visualizer analyze job and follows it through the jobs store.
 * When the job is done it loads the analysis files (through the media route)
 * and puts the ref and the Analysis into the Visualizer store.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { JobStatus, JobsService, MediaService, VisualizerService, type AnalysisRef } from "@/lib/api";
import { toAppError, type AppErrorShape } from "@/lib/errors";
import { isActive, useJob, type JobView } from "@/state/jobs";
import { loadAnalysis, type Analysis } from "@/viz/analysis";
import { useVisualizer } from "../store";
import { cleanOptions, NEW_TRACKER, trackMessage, type RunPhase, type StageTracker } from "./logic";

export interface AnalyzeRun {
  job: JobView | undefined;
  phase: RunPhase | "idle";
  tracker: StageTracker;
  /** A submit-time or load failure. */
  error: AppErrorShape | null;
  loading: boolean;
  start(): Promise<void>;
  cancel(): void;
}

export function parseAnalysisRef(resultJson: string | undefined): AnalysisRef | null {
  if (!resultJson) return null;
  try {
    const r = JSON.parse(resultJson) as { analysis?: AnalysisRef | null };
    return r.analysis ?? null;
  } catch {
    return null;
  }
}

export async function loadRef(ref: AnalysisRef): Promise<Analysis> {
  const [audioJsonUrl, featuresUrl, textJsonUrl] = await Promise.all([
    MediaService.URLFor(ref.audioJson),
    MediaService.URLFor(ref.featuresPath),
    ref.textJson ? MediaService.URLFor(ref.textJson) : Promise.resolve(undefined),
  ]);
  return loadAnalysis({ audioJsonUrl, featuresUrl, textJsonUrl });
}

export function useAnalyzeRun(onDone?: () => void): AnalyzeRun {
  const [id, setId] = useState("");
  const [error, setError] = useState<AppErrorShape | null>(null);
  const [loading, setLoading] = useState(false);
  const [tracker, setTracker] = useState<StageTracker>(NEW_TRACKER);
  const job = useJob(id);
  const handled = useRef("");
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const message = job?.message ?? "";
  useEffect(() => {
    if (message) setTracker((t) => trackMessage(t, message));
  }, [message]);

  useEffect(() => {
    if (!job || job.status !== JobStatus.JobDone || handled.current === job.id) return;
    handled.current = job.id;
    const ref = parseAnalysisRef(job.resultJson);
    if (!ref) {
      setError({ code: "internal", message: "The analysis finished but its result is missing", hint: "Try analysing again." });
      return;
    }
    let cancelled = false;
    setLoading(true);
    loadRef(ref)
      .then((a) => {
        if (cancelled) return;
        useVisualizer.getState().setAnalysis(ref, a);
        doneRef.current?.();
      })
      .catch((e) => !cancelled && setError(toAppError(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [job]);

  const start = useCallback(async () => {
    const s = useVisualizer.getState();
    if (!s.input) return;
    setError(null);
    setTracker(NEW_TRACKER);
    setId("");
    try {
      const defaults = await VisualizerService.Defaults();
      const jobs = await VisualizerService.Enqueue([s.input], { ...defaults, action: "analyze" as typeof defaults.action, mode: s.mode as typeof defaults.mode, analyze: cleanOptions(s.analyze) });
      const first = jobs?.[0];
      if (first) setId(first.id);
    } catch (e) {
      setError(toAppError(e));
    }
  }, []);

  const cancel = useCallback(() => {
    if (id) JobsService.Cancel(id).catch(() => undefined);
  }, [id]);

  let phase: AnalyzeRun["phase"] = "idle";
  if (job) {
    if (job.status === JobStatus.JobQueued) phase = "queued";
    else if (isActive(job)) phase = "running";
    else if (job.status === JobStatus.JobDone) phase = "done";
    else if (job.status === JobStatus.JobFailed) phase = "failed";
    else phase = "cancelled";
  }
  return { job, phase, tracker, error, loading, start, cancel };
}
