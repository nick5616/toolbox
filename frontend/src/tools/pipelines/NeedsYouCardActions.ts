import { toast } from "@/components";
import { JobStatus, PipelinesService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import type { JobView } from "@/state/jobs";
import type { WaitingCell } from "@/state/pipelines";

// Actions on a waiting cell, shared by the Needs-you card and the shell banner.

function report(e: unknown): void {
  const err = toAppError(e);
  toast({ tone: "danger", title: err.message, description: err.hint });
}

/** Jobs the runner adopted into the cell so far (known to the jobs store). */
export function adoptedJobs(w: WaitingCell, byId: Record<string, JobView>): JobView[] {
  return w.cell.jobIds.map((id) => byId[id]).filter((j): j is JobView => !!j);
}

/** An adopted job finished with at least one output: Continue can use it. */
export function hasDoneAdopted(jobs: readonly JobView[]): boolean {
  return jobs.some((j) => j.status === JobStatus.JobDone && j.outputs.length > 0);
}

export function continueManual(w: WaitingCell, passThrough: boolean): void {
  PipelinesService.Continue({ runId: w.run.id, item: w.item.index, stepId: w.step.id, keep: null, passThrough }).catch(report);
}

export function continueCheck(w: WaitingCell, keep: string[]): void {
  PipelinesService.Continue({ runId: w.run.id, item: w.item.index, stepId: w.step.id, keep, passThrough: false }).catch(report);
}

export function skipStep(w: WaitingCell): void {
  PipelinesService.SkipStep(w.run.id, w.item.index, w.step.id).catch(report);
}

export function stopItem(w: WaitingCell): void {
  PipelinesService.StopItem(w.run.id, w.item.index).catch(report);
}

export { report as reportPipelineError };
