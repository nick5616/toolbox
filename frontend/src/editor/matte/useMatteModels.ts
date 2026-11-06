import { useEffect, useState } from "react";
import { EditStudioService, JobStatus, type EditMatteModels } from "@/lib/api";
import { useJobs } from "@/state/jobs";

export const PACK_HINT: Record<"people" | "select" | "image", string> = {
  people: "Install the Music edits tool pack in Settings",
  select: "Install the Music edits tool pack in Settings",
  image: "Install the Image tool pack in Settings",
};

/**
 * Which cut-out models are installed (null while unknown: nothing is disabled
 * until the answer arrives). Asked again whenever a job finishes (a pack
 * install or a model download) and when the window regains focus.
 */
export function useMatteModels(): EditMatteModels | null {
  const [models, setModels] = useState<EditMatteModels | null>(null);
  const finished = useJobs((s) => {
    let n = 0;
    for (const j of Object.values(s.byId)) if (j.status === JobStatus.JobDone) n++;
    return n;
  });
  const [focus, setFocus] = useState(0);
  useEffect(() => {
    const on = () => setFocus((f) => f + 1);
    window.addEventListener("focus", on);
    return () => window.removeEventListener("focus", on);
  }, []);
  useEffect(() => {
    let live = true;
    EditStudioService.MatteModels().then(
      (m) => live && setModels(m),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [finished, focus]);
  return models;
}
