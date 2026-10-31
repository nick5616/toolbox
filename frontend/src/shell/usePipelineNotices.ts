import { useEffect } from "react";
import { toast } from "@/components";
import { WaitKind } from "@/lib/api";
import { useModules } from "@/state/modules";
import { usePipelines, waitingCells, type WaitingCell } from "@/state/pipelines";
import { useUI } from "@/state/ui";

// --- pipelines ---
// Toasts "<run> needs you" when a manual or check cell starts waiting. Only
// transitions seen live count: whatever is waiting once the runs have loaded
// is recorded silently.

export const waitKey = (w: WaitingCell): string => `${w.run.id}:${w.item.index}:${w.step.id}:${w.kind}`;

function notify(w: WaitingCell): void {
  const manual = w.kind === WaitKind.WaitManual;
  const tool = useModules.getState().byId[w.step.type]?.name ?? w.step.type;
  const action = manual
    ? {
        label: `Open ${tool}`,
        onClick: () => useUI.getState().handOff({ moduleId: w.step.type, inputs: w.cell.inputs.map((f) => f.path) }),
      }
    : {
        label: "Check files",
        onClick: () => {
          useUI.getState().navigate("pipelines");
          usePipelines.getState().showRun(w.run.id);
        },
      };
  toast({
    title: `${w.run.name} needs you`,
    description: w.step.label || (manual ? tool : "Check files"),
    action,
    duration: typeof document !== "undefined" && document.hasFocus() ? 8000 : 0,
  });
}

export function usePipelineNotices(): void {
  useEffect(() => {
    let known = new Set<string>();
    let primed = false;
    let lastRuns = usePipelines.getState().runs;

    const check = () => {
      const s = usePipelines.getState();
      const cells = waitingCells(s.runs);
      const keys = new Set(cells.map(waitKey));
      if (primed) {
        for (const w of cells) if (!known.has(waitKey(w))) notify(w);
      }
      known = keys;
      if (s.loaded) primed = true;
    };
    check();

    return usePipelines.subscribe((s) => {
      if (s.runs === lastRuns && primed) return;
      lastRuns = s.runs;
      check();
    });
  }, []);
}
// --- end pipelines ---
