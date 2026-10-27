import { useEffect } from "react";
import { JobStatus, LibraryService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { toast } from "@/components";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";

function isActiveStatus(s: string | undefined): boolean {
  return s === JobStatus.JobQueued || s === JobStatus.JobRunning;
}

/**
 * Toasts for jobs that finish (active -> failed/done) while the tray is
 * collapsed. Jobs that were already finished at subscribe time never toast.
 */
export function useJobToasts(): void {
  useEffect(() => {
    const seen = new Map<string, string>();
    for (const j of Object.values(useJobs.getState().byId)) seen.set(j.id, j.status);

    return useJobs.subscribe((s) => {
      for (const j of Object.values(s.byId)) {
        const prev = seen.get(j.id);
        if (prev === j.status) continue;
        seen.set(j.id, j.status);
        if (!isActiveStatus(prev) || useUI.getState().trayOpen) continue;
        if (j.status === JobStatus.JobFailed) {
          const mod = useModules.getState().byId[j.moduleId]?.name ?? "Job";
          const title = j.title || j.inputs[0] || j.id;
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
        } else if (j.status === JobStatus.JobDone) {
          const out = j.outputs[0];
          toast({
            tone: "success",
            title: out ? `Saved ${out.name}` : `Finished ${j.title || j.id}`,
            action: out
              ? {
                  label: "Reveal",
                  onClick: () => {
                    LibraryService.Reveal(out.id).catch((e: unknown) =>
                      toast({ tone: "danger", title: toAppError(e).message }),
                    );
                  },
                }
              : undefined,
          });
        }
      }
    });
  }, []);
}
