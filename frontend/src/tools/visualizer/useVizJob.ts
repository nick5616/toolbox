import { useCallback } from "react";
import { create } from "zustand";
import { JobsService, VisualizerService, type VisualizerOptions, type VisualizerResult } from "@/lib/api";
import { toAppError, type AppErrorShape } from "@/lib/errors";
import { announceWhenDone, isActive, useJob, type JobView } from "@/state/jobs";

export interface VizJob {
  job: JobView | undefined;
  busy: boolean;
  error: AppErrorShape | null;
  start(inputs: string[], opts: VisualizerOptions): Promise<void>;
  cancel(): void;
  clear(): void;
}

export type VizSlot = "render" | "preview";

interface VizJobsState {
  ids: Record<VizSlot, string>;
  submitting: Record<VizSlot, boolean>;
  errors: Record<VizSlot, AppErrorShape | null>;
}

/** Job ids live here, not in the Export drawer, so closing it keeps progress and result. */
export const useVizJobs = create<VizJobsState>()(() => ({
  ids: { render: "", preview: "" },
  submitting: { render: false, preview: false },
  errors: { render: null, preview: null },
}));

const patch = <K extends keyof VizJobsState>(key: K, slot: VizSlot, value: VizJobsState[K][VizSlot]) =>
  useVizJobs.setState((s) => ({ [key]: { ...s[key], [slot]: value } }) as Pick<VizJobsState, K>);

/** Submits one Visualizer job in a slot and follows it; the slot survives the panel closing. */
export function useVizJob(slot: VizSlot): VizJob {
  const id = useVizJobs((s) => s.ids[slot]);
  const submitting = useVizJobs((s) => s.submitting[slot]);
  const error = useVizJobs((s) => s.errors[slot]);
  const job = useJob(id);

  const start = useCallback(
    async (inputs: string[], opts: VisualizerOptions) => {
      patch("errors", slot, null);
      patch("submitting", slot, true);
      try {
        const jobs = await VisualizerService.Enqueue(inputs, opts);
        const first = jobs?.[0];
        if (first) {
          announceWhenDone(first.id);
          patch("ids", slot, first.id);
        }
      } catch (e) {
        patch("errors", slot, toAppError(e));
      } finally {
        patch("submitting", slot, false);
      }
    },
    [slot],
  );

  const cancel = useCallback(() => {
    if (id) JobsService.Cancel(id).catch(() => undefined);
  }, [id]);
  const clear = useCallback(() => {
    patch("ids", slot, "");
    patch("errors", slot, null);
  }, [slot]);

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
