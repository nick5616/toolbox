import { useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { displayText } from "@/lib/displayPath";
import { JobsService, JobStatus, type Job, type JobLogBatch, type JobProgress, type LogLine } from "@/lib/api";

/** In-memory cap per job; older lines are dropped from the front. */
export const MAX_LOG_LINES_IN_MEMORY = 5000;

/** Job with Go's nullable slices normalised to arrays. */
export type JobView = Job & { inputs: string[]; outputs: NonNullable<Job["outputs"]> };

export function normalizeJob(j: Job): JobView {
  // Titles are display text and some carry a path (Phase 21 §A5: Hide personal details).
  return { ...j, title: displayText(j.title), inputs: j.inputs ?? [], outputs: j.outputs ?? [] };
}

export function isActive(j: Job): boolean {
  return j.status === JobStatus.JobQueued || j.status === JobStatus.JobRunning;
}

/**
 * Jobs whose finish should toast (with Reveal) even while their tool is on
 * screen: for jobs the tool doesn't show a result for itself (Edit Studio's
 * SRT and marker exports). The shell's job toasts read and clear it.
 */
const announced = new Set<string>();
export function announceWhenDone(jobId: string): void {
  if (jobId) announced.add(jobId);
}
/** True (once) when the job was marked with `announceWhenDone`. */
export function takeAnnounced(jobId: string): boolean {
  return announced.delete(jobId);
}

/**
 * The opposite: jobs a tool started for itself and shows the result of, even
 * though they belong to another module (Post Builder rendering a Video Editor
 * preview to play). Their finish never toasts; failures still do.
 */
const muted = new Set<string>();
export function muteWhenDone(jobId: string): void {
  if (jobId) muted.add(jobId);
}
/** True (once) when the job was marked with `muteWhenDone`. */
export function takeMuted(jobId: string): boolean {
  return muted.delete(jobId);
}

interface JobsState {
  byId: Record<string, JobView>;
  logs: Record<string, LogLine[]>;
  logsLoaded: Record<string, boolean>;

  setAll: (jobs: Job[]) => void;
  upsert: (job: Job) => void;
  applyProgress: (p: JobProgress) => void;
  /** Applies many progress updates in one store update (later entries win per job). */
  applyProgressBatch: (batch: readonly JobProgress[]) => void;
  appendLogs: (batch: JobLogBatch) => void;
  removeLocal: (ids: string[]) => void;

  loadLogs: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  cancelAll: () => Promise<void>;
  retry: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  clearFinished: () => Promise<number>;
}

function appendCapped(prev: LogLine[] | undefined, lines: LogLine[]): LogLine[] {
  const next = prev ? prev.concat(lines) : lines.slice();
  return next.length > MAX_LOG_LINES_IN_MEMORY ? next.slice(next.length - MAX_LOG_LINES_IN_MEMORY) : next;
}

export const useJobs = create<JobsState>((set, get) => ({
  byId: {},
  logs: {},
  logsLoaded: {},

  setAll: (jobs) => set({ byId: Object.fromEntries(jobs.map((j) => [j.id, normalizeJob(j)])) }),
  upsert: (job) => set((s) => ({ byId: { ...s.byId, [job.id]: normalizeJob(job) } })),
  applyProgress: (p) =>
    set((s) => {
      const j = s.byId[p.id];
      if (!j || j.status !== JobStatus.JobRunning) return s;
      return { byId: { ...s.byId, [p.id]: { ...j, progress: p.progress, message: p.message } } };
    }),
  applyProgressBatch: (batch) =>
    set((s) => {
      let byId: Record<string, JobView> | null = null;
      for (const p of batch) {
        const j = (byId ?? s.byId)[p.id];
        if (!j || j.status !== JobStatus.JobRunning) continue;
        if (j.progress === p.progress && j.message === p.message) continue;
        byId ??= { ...s.byId };
        byId[p.id] = { ...j, progress: p.progress, message: p.message };
      }
      return byId ? { byId } : s;
    }),
  appendLogs: (batch) =>
    set((s) => {
      // Only keep live lines for jobs whose log was opened (or loaded) to save memory.
      if (!s.logsLoaded[batch.id] && !s.logs[batch.id]) return s;
      return { logs: { ...s.logs, [batch.id]: appendCapped(s.logs[batch.id], batch.lines ?? []) } };
    }),
  removeLocal: (ids) =>
    set((s) => {
      const byId = { ...s.byId };
      const logs = { ...s.logs };
      const logsLoaded = { ...s.logsLoaded };
      for (const id of ids) {
        delete byId[id];
        delete logs[id];
        delete logsLoaded[id];
      }
      return { byId, logs, logsLoaded };
    }),

  loadLogs: async (id) => {
    if (get().logsLoaded[id]) return;
    // Mark first so live batches arriving during the fetch are kept.
    set((s) => ({ logsLoaded: { ...s.logsLoaded, [id]: true }, logs: { ...s.logs, [id]: s.logs[id] ?? [] } }));
    const persisted = (await JobsService.Logs(id)) ?? [];
    set((s) => {
      const live = s.logs[id] ?? [];
      const lastSeq = persisted.length ? persisted[persisted.length - 1]!.seq : -1;
      const merged = persisted.concat(live.filter((l) => l.seq > lastSeq));
      return { logs: { ...s.logs, [id]: appendCapped(undefined, merged) } };
    });
  },
  cancel: async (id) => {
    await JobsService.Cancel(id);
  },
  cancelAll: async () => {
    await JobsService.CancelAll();
  },
  retry: async (id) => {
    const j = await JobsService.Retry(id);
    get().upsert(j);
    set((s) => ({ logsLoaded: { ...s.logsLoaded, [id]: false }, logs: { ...s.logs, [id]: [] } }));
  },
  remove: async (id) => {
    await JobsService.Remove(id);
    get().removeLocal([id]);
  },
  clearFinished: async () => {
    const n = await JobsService.ClearFinished();
    const finished = Object.values(get().byId)
      .filter((j) => !isActive(j))
      .map((j) => j.id);
    get().removeLocal(finished);
    return n;
  },
}));

// --- progress batching -----------------------------------------------------
// Go sends up to ~10 progress events per second per job. They are buffered by
// job id (latest wins) and applied in one store update per animation frame
// (250 ms timer while the window is hidden, where rAF doesn't fire).
// Status changes (`jobs:changed`) are never batched; call flushProgress() first.

const pendingProgress = new Map<string, JobProgress>();
let flushHandle: { kind: "raf" | "timeout"; id: number } | null = null;

function cancelScheduled(): void {
  if (!flushHandle) return;
  if (flushHandle.kind === "raf") cancelAnimationFrame(flushHandle.id);
  else clearTimeout(flushHandle.id);
  flushHandle = null;
}

/** Applies every buffered progress update now. */
export function flushProgress(): void {
  cancelScheduled();
  if (pendingProgress.size === 0) return;
  const batch = Array.from(pendingProgress.values());
  pendingProgress.clear();
  useJobs.getState().applyProgressBatch(batch);
}

/** Buffers a progress event and schedules one flush. */
export function queueProgress(p: JobProgress): void {
  pendingProgress.set(p.id, p);
  if (flushHandle) return;
  if (typeof document !== "undefined" && document.hidden) {
    flushHandle = { kind: "timeout", id: window.setTimeout(flushProgress, 250) };
  } else if (typeof requestAnimationFrame === "function") {
    flushHandle = { kind: "raf", id: requestAnimationFrame(flushProgress) };
  } else {
    flushHandle = { kind: "timeout", id: window.setTimeout(flushProgress, 16) };
  }
}

/** Active jobs (oldest first) followed by finished jobs (most recently finished first). */
export function orderJobs(jobs: JobView[]): JobView[] {
  const active = jobs.filter(isActive).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const done = jobs
    .filter((j) => !isActive(j))
    .sort((a, b) => (b.finishedAt || b.createdAt) - (a.finishedAt || a.createdAt));
  return active.concat(done);
}

export interface JobCounts {
  queued: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  total: number;
}

export function countJobs(jobs: JobView[]): JobCounts {
  const c: JobCounts = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, total: jobs.length };
  for (const j of jobs) {
    if (j.status === JobStatus.JobQueued) c.queued++;
    else if (j.status === JobStatus.JobRunning) c.running++;
    else if (j.status === JobStatus.JobDone) c.done++;
    else if (j.status === JobStatus.JobFailed) c.failed++;
    else if (j.status === JobStatus.JobCancelled) c.cancelled++;
  }
  return c;
}

/** All jobs in display order (optionally for one module). Stable across unrelated renders. */
export function useOrderedJobs(moduleId?: string): JobView[] {
  // Shallow-stable: another module's progress doesn't change this list's identity.
  const list = useJobs(
    useShallow((s) => {
      const all = Object.values(s.byId);
      return moduleId ? all.filter((j) => j.moduleId === moduleId) : all;
    }),
  );
  return useMemo(() => orderJobs(list), [list]);
}

/** True while any job of the module is queued or running (a boolean: progress ticks don't re-render). */
export function useModuleBusy(moduleId: string): boolean {
  return useJobs((s) => Object.values(s.byId).some((j) => j.moduleId === moduleId && isActive(j)));
}

export function useJobCounts(): JobCounts {
  const byId = useJobs((s) => s.byId);
  return useMemo(() => countJobs(Object.values(byId)), [byId]);
}

export function useJob(id: string): JobView | undefined {
  return useJobs((s) => s.byId[id]);
}
