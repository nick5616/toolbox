import { toast } from "@/components";
import { PipelinesService, type PipelineEntry } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { usePipelines } from "@/state/pipelines";

// Runs without files (Phase 18, SPEC §3.5, §5.3): a pipeline where no step reads
// the run's files has a Run button instead of "drop files".

/** True when the pipeline starts with no files (the check says so; unknown counts as "takes files"). */
export function startsWithoutFiles(entry: Pick<PipelineEntry, "check"> | undefined): boolean {
  return entry?.check.takesFiles === false;
}

/** True when the run needs the sheet first: run parameters or passwords to ask. */
export function needsRunSheet(entry: Pick<PipelineEntry, "pipeline" | "check">): boolean {
  return (entry.pipeline.params ?? []).length > 0 || (entry.check.secrets ?? []).length > 0;
}

/** Why Run is off ("" = it isn't). */
export function runDisabledReason(entry: Pick<PipelineEntry, "check">): string {
  return entry.check.ready ? "" : "Fix this pipeline's problems before running it";
}

/**
 * Runs a no-files pipeline: starts it at once, or opens the Run sheet when it
 * has parameters or passwords to ask. Failures show as a toast.
 */
export async function runWithoutFiles(entry: PipelineEntry): Promise<void> {
  const s = usePipelines.getState();
  if (needsRunSheet(entry)) {
    s.openRunSheet(entry.pipeline.id);
    return;
  }
  try {
    const run = await PipelinesService.Start({ pipelineId: entry.pipeline.id, inputs: [], secrets: {}, params: {} });
    s.upsertRun(run);
    s.showRun(run.id);
  } catch (e) {
    toast({ title: `Couldn't run ${entry.pipeline.name}`, description: toAppError(e).message, tone: "danger" });
  }
}
