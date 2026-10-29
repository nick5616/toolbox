import { useCallback, useEffect, useReducer, useRef } from "react";
import { JobStatus, MediaService, type MediaSource } from "@/lib/api";
import { toAppError, type AppErrorShape } from "@/lib/errors";
import { useJobs } from "@/state/jobs";

export type MediaSourceStatus = "idle" | "loading" | "preparing" | "ready" | "error";

export interface MediaSourceState {
  status: MediaSourceStatus;
  source?: MediaSource;
  /** 0..1 while a preview copy is being made. */
  progress?: number;
  error?: AppErrorShape;
  retry(): void;
}

interface Internal {
  status: MediaSourceStatus;
  source?: MediaSource;
  jobId?: string;
  error?: AppErrorShape;
}

type Action =
  | { type: "reset" }
  | { type: "loading" }
  | { type: "opened"; source: MediaSource }
  | { type: "failed"; error: AppErrorShape };

/** The state machine, exported for tests. */
export function reduce(_s: Internal, a: Action): Internal {
  switch (a.type) {
    case "reset":
      return { status: "idle" };
    case "loading":
      // Keep the job id while re-opening after a preview copy finished.
      return { status: "loading" };
    case "opened":
      if (a.source.url) return { status: "ready", source: a.source };
      if (a.source.proxyJobId) return { status: "preparing", source: a.source, jobId: a.source.proxyJobId };
      return { status: "error", error: { code: "internal", message: "The preview copy could not be started." } };
    case "failed":
      return { status: "error", error: a.error };
  }
}

/** How long to wait before re-opening when the preview job never shows up in the store. */
export const MISSING_JOB_REOPEN_MS = 2000;

/**
 * Opens a local file for playback through MediaService.Open, follows the
 * preview-copy job when the webview can't play it, then re-opens
 * (SPEC.md §3.11).
 */
export function useMediaSource(path: string | null): MediaSourceState {
  const [state, dispatch] = useReducer(reduce, { status: path ? "loading" : "idle" } as Internal);
  const [attempt, bump] = useReducer((n: number) => n + 1, 0);
  const jobId = state.status === "preparing" ? state.jobId : undefined;
  const job = useJobs((s) => (jobId ? s.byId[jobId] : undefined));
  const jobStatus = job?.status;
  const handled = useRef<string>("");

  // Open whenever the path changes (or retry / re-open is requested).
  useEffect(() => {
    if (!path) {
      dispatch({ type: "reset" });
      return;
    }
    let cancelled = false;
    dispatch({ type: "loading" });
    MediaService.Open(path).then(
      (source) => {
        if (!cancelled) dispatch({ type: "opened", source });
      },
      (e: unknown) => {
        if (!cancelled) dispatch({ type: "failed", error: toAppError(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, attempt]);

  // Follow the preview-copy job.
  useEffect(() => {
    if (!jobId) return;
    if (jobStatus === JobStatus.JobDone) {
      const key = `${jobId}:done`;
      if (handled.current === key) return;
      handled.current = key;
      bump();
    } else if (jobStatus === JobStatus.JobFailed || jobStatus === JobStatus.JobCancelled) {
      const key = `${jobId}:${jobStatus}`;
      if (handled.current === key) return;
      handled.current = key;
      dispatch({
        type: "failed",
        error:
          jobStatus === JobStatus.JobCancelled
            ? { code: "cancelled", message: "Preparing the preview copy was cancelled." }
            : {
                code: job?.errorCode || "internal",
                message: job?.error || "Preparing the preview copy failed.",
                ...(job?.errorHint ? { hint: job.errorHint } : {}),
              },
      });
    } else if (jobStatus === undefined) {
      // The job isn't in the store (finished before we listened, or the event was missed): ask again.
      const t = setTimeout(bump, MISSING_JOB_REOPEN_MS);
      return () => clearTimeout(t);
    }
  }, [jobId, jobStatus, job?.errorCode, job?.error, job?.errorHint]);

  const retry = useCallback(() => {
    handled.current = "";
    bump();
  }, []);

  let progress: number | undefined;
  if (state.status === "preparing" && job && job.progress >= 0) progress = Math.min(1, job.progress);

  const out: MediaSourceState = { status: path ? state.status : "idle", retry };
  if (path && state.source) out.source = state.source;
  if (progress !== undefined) out.progress = progress;
  if (path && state.error) out.error = state.error;
  return out;
}
