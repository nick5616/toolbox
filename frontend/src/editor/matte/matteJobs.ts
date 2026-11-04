/**
 * Following matte jobs (Phase 9 SPEC §10.5, §10.7). A job outlives the Inspector section that started it, so
 * the watcher lives here (module level): when the job is done it refreshes the matte's state.
 */
import { JobStatus, type EditMatteRequest, type EditResult } from "@/lib/api";
import { isActive, useJobs, type JobView } from "@/state/jobs";
import { refreshMattes } from "@/editor/useEditData";
import { useEditStudio } from "@/editor/store";
import type { JobPhase } from "./matteUtil";

/** Edit jobs are filed under Edit Studio, or the Video Editor for projects without a song analysis (Phase 10 §5.4). */
const MODULE_IDS: ReadonlySet<string> = new Set(["edit-studio", "video-studio"]);

/** The matte request an Edit Studio job carries (null for other jobs). */
export function matteRequestOf(job: Pick<JobView, "moduleId" | "optionsJson">): EditMatteRequest | null {
  if (!MODULE_IDS.has(job.moduleId)) return null;
  try {
    const o = JSON.parse(job.optionsJson) as { action?: string; matte?: EditMatteRequest | null };
    return o.action === "matte" && o.matte ? o.matte : null;
  } catch {
    return null;
  }
}

export function jobPhase(job: JobView | undefined): JobPhase {
  if (!job) return "none";
  if (isActive(job)) return "active";
  return job.status === JobStatus.JobFailed ? "failed" : "none";
}

/** The job's result (matte state, try path), or null. */
export function resultOf(job: Pick<JobView, "resultJson">): EditResult | null {
  if (!job.resultJson) return null;
  try {
    return JSON.parse(job.resultJson) as EditResult;
  } catch {
    return null;
  }
}

const followed = new Set<string>();

/**
 * Watches a matte job until it ends: done → refresh the matte's state and forget the job; cancelled → forget it;
 * failed → keep it so the Inspector can show the error. Returns a stop function.
 */
export function followMatteJob(matteId: string, jobId: string): () => void {
  const key = `${matteId}|${jobId}`;
  if (followed.has(key)) return () => undefined;
  followed.add(key);
  let stopped = false;
  let unsub: () => void = () => undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    followed.delete(key);
    unsub();
  };
  const check = (job: JobView | undefined) => {
    if (!job || isActive(job)) return;
    stop();
    if (job.status === JobStatus.JobDone) {
      void refreshMattes([matteId]);
      useEditStudio.getState().setMatteJob(matteId, undefined);
    } else if (job.status === JobStatus.JobCancelled) {
      useEditStudio.getState().setMatteJob(matteId, undefined);
    }
  };
  unsub = useJobs.subscribe((s) => check(s.byId[jobId]));
  check(useJobs.getState().byId[jobId]);
  return stop;
}

/** The newest real (not preview) matte job for a matte: the store's job, else any Edit Studio job that carries its ID. */
export function useMatteJob(matteId: string): JobView | undefined {
  const known = useEditStudio((s) => s.jobs.mattes[matteId] ?? "");
  return useJobs((s) => {
    const k = known ? s.byId[known] : undefined;
    if (k) return k;
    if (!matteId) return undefined;
    let best: JobView | undefined;
    for (const j of Object.values(s.byId)) {
      const r = matteRequestOf(j);
      if (r && !r.preview && r.matteId === matteId && (!best || j.createdAt > best.createdAt)) best = j;
    }
    return best;
  });
}
