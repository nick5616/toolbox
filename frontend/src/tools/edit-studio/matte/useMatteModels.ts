import { useEffect, useState } from "react";
import { EditStudioService, type EditMatteModels } from "@/lib/api";

export const PACK_HINT: Record<"people" | "select" | "image", string> = {
  people: "Install the Music edits tool pack in Settings",
  select: "Install the Music edits tool pack in Settings",
  image: "Install the Image tool pack in Settings",
};

/** Which cut-out models are installed (null while unknown: nothing is disabled until the answer arrives). */
export function useMatteModels(): EditMatteModels | null {
  const [models, setModels] = useState<EditMatteModels | null>(null);
  useEffect(() => {
    let live = true;
    EditStudioService.MatteModels().then(
      (m) => live && setModels(m),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return models;
}
