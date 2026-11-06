import { useEffect } from "react";
import { JobStatus, LibraryService, type Output } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { toast } from "@/components";
import { useJobs, type JobView as Job } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { useBatchResults } from "./batchResults";

function isActiveStatus(s: string | undefined): boolean {
  return s === JobStatus.JobQueued || s === JobStatus.JobRunning;
}

/** Jobs of one tool created within this window are one submission (a batch). */
export const BATCH_WINDOW_MS = 2000;
/** After the last job of a batch ends, wait this long for stragglers before toasting. */
export const BATCH_SETTLE_MS = 400;

interface Batch {
  moduleId: string;
  createdAt: number;
  ids: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
}

function reveal(out: Output): void {
  LibraryService.Reveal(out.id).catch((e: unknown) => toast({ tone: "danger", title: toAppError(e).message }));
}

/** The toast for a finished batch (`jobs` are the ones that succeeded). */
export function notifyDone(moduleId: string, jobs: Job[]): void {
  const ui = useUI.getState();
  // Looking at the tool's results already: no toast.
  if (ui.view === moduleId || ui.trayOpen) return;
  const outputs = jobs.flatMap((j) => j.outputs ?? []);
  const mod = useModules.getState().byId[moduleId]?.name ?? "Job";
  if (jobs.length === 1) {
    const j = jobs[0]!;
    const out = outputs[0];
    toast({
      tone: "success",
      title: out ? `Saved ${out.name}` : `Finished ${j.title || j.id}`,
      action: out ? { label: "Reveal", onClick: () => reveal(out) } : undefined,
    });
    return;
  }
  const n = outputs.length || jobs.length;
  toast({
    tone: "success",
    title: `${mod}: ${n} ${n === 1 ? "file" : "files"} saved`,
    action: outputs.length > 0 ? { label: "Send to…", onClick: () => useBatchResults.getState().show({ moduleId, title: `${mod}: ${n} files saved`, outputs }) } : undefined,
  });
}

/**
 * Toasts for jobs that finish (active -> failed/done) while the tray is
 * collapsed. Jobs that were already finished at subscribe time never toast.
 * A tool that is on screen shows its own results, so it gets no completion
 * toast. The jobs of one submission (same tool, created together) merge into
 * one toast when the last one ends.
 */
export function useJobToasts(): void {
  useEffect(() => {
    const seen = new Map<string, string>();
    const batchOf = new Map<string, Batch>();
    const batches = new Set<Batch>();
    for (const j of Object.values(useJobs.getState().byId)) seen.set(j.id, j.status);

    const join = (j: Job): Batch => {
      for (const b of batches) {
        if (b.moduleId === j.moduleId && Math.abs(b.createdAt - j.createdAt) <= BATCH_WINDOW_MS) {
          b.ids.add(j.id);
          return b;
        }
      }
      const b: Batch = { moduleId: j.moduleId, createdAt: j.createdAt, ids: new Set([j.id]) };
      batches.add(b);
      return b;
    };

    const settle = (b: Batch) => {
      const byId = useJobs.getState().byId;
      const jobs = [...b.ids].map((id) => byId[id]).filter((j): j is Job => !!j);
      if (jobs.some((j) => isActiveStatus(j.status))) return;
      clearTimeout(b.timer);
      b.timer = setTimeout(() => {
        const now = useJobs.getState().byId;
        const list = [...b.ids].map((id) => now[id]).filter((j): j is Job => !!j);
        if (list.some((j) => isActiveStatus(j.status))) return;
        batches.delete(b);
        for (const id of b.ids) batchOf.delete(id);
        const done = list.filter((j) => j.status === JobStatus.JobDone);
        if (done.length > 0) notifyDone(b.moduleId, done);
      }, BATCH_SETTLE_MS);
    };

    const unsub = useJobs.subscribe((s) => {
      for (const j of Object.values(s.byId)) {
        const prev = seen.get(j.id);
        if (prev === j.status) continue;
        seen.set(j.id, j.status);
        // A job first seen already finished still ended just now.
        const wasActive = prev === undefined || isActiveStatus(prev);
        if (!batchOf.has(j.id)) batchOf.set(j.id, join(j));
        const batch = batchOf.get(j.id);
        if (!wasActive) continue;
        if (isActiveStatus(j.status)) {
          if (batch) clearTimeout(batch.timer);
          continue;
        }
        if (j.status === JobStatus.JobFailed && !useUI.getState().trayOpen) {
          const mod = useModules.getState().byId[j.moduleId]?.name ?? "Job";
          const title = j.title || j.inputs?.[0] || j.id;
          toast({
            tone: "danger",
            title: `${mod} failed: ${title}`,
            description: j.error || undefined,
            action: {
              label: "Show",
              onClick: () => {
                useUI.getState().setTrayOpen(true);
                useUI.getState().setExpandedLogJobId(j.id);
              },
            },
          });
        }
        if (batch) settle(batch);
      }
    });
    return () => {
      unsub();
      for (const b of batches) clearTimeout(b.timer);
    };
  }, []);
}
