import { useMemo } from "react";
import { create } from "zustand";
import { JobsService, JobStatus, type Job, type JobLogBatch, type JobProgress, type LogLine } from "@/lib/api";

/** In-memory cap per job; older lines are dropped from the front. */
export const MAX_LOG_LINES_IN_MEMORY = 5000;

/** Job with Go's nullable slices normalised to arrays. */
export type JobView = Job & { inputs: string[]; outputs: NonNullable<Job["outputs"]> };

export function normalizeJob(j: Job): JobView {
  return { ...j, inputs: j.inputs ?? [], outputs: j.outputs ?? [] };
}

export function isActive(j: Job): boolean {
  return j.status === JobStatus.JobQueued || j.status === JobStatus.JobRunning;
}

interface JobsState {
  byId: Record<string, JobView>;
  logs: Record<string, LogLine[]>;
  logsLoaded: Record<string, boolean>;

  setAll: (jobs: Job[]) => void;
  upsert: (job: Job) => void;
  applyProgress: (p: JobProgress) => void;
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
  const byId = useJobs((s) => s.byId);
  return useMemo(() => {
    const all = Object.values(byId);
    return orderJobs(moduleId ? all.filter((j) => j.moduleId === moduleId) : all);
  }, [byId, moduleId]);
}

export function useJobCounts(): JobCounts {
  const byId = useJobs((s) => s.byId);
  return useMemo(() => countJobs(Object.values(byId)), [byId]);
}

export function useJob(id: string): JobView | undefined {
  return useJobs((s) => s.byId[id]);
}
