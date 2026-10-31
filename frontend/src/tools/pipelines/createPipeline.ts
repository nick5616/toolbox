import { toast } from "@/components";
import { PipelinesService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { fillVisualizerDesigns } from "@/pipelines/visualizerDesigns";
import { usePipelines } from "@/state/pipelines";
import { useUI } from "@/state/ui";
import { blankPipeline, withEntry } from "./editorModel";

/**
 * Creates a pipeline from a template (or a blank one when `templateId` is
 * null), saves it and selects it. Returns the new ID, or null after showing
 * the error.
 */
export async function createPipeline(templateId: string | null): Promise<string | null> {
  try {
    const store = usePipelines.getState();
    await store.ensureCatalog().catch(() => undefined);
    const state = usePipelines.getState();
    const names = state.entries.map((e) => e.pipeline.name);
    const draft = templateId === null ? blankPipeline(state.catalog, names) : await PipelinesService.FromTemplate(templateId);
    const saved = await PipelinesService.Save(fillVisualizerDesigns(draft));
    const next = usePipelines.getState();
    next.setEntries(withEntry(next.entries, saved));
    next.selectPipeline(saved.pipeline.id);
    next.setTab("pipelines");
    return saved.pipeline.id;
  } catch (e) {
    toast({ title: "Couldn't create the pipeline", description: toAppError(e).message, tone: "danger" });
    return null;
  }
}

/** Opens Settings and scrolls to Tool packs. */
export function openToolPacks(): void {
  useUI.getState().navigate("settings");
  let tries = 0;
  const tick = () => {
    const el = document.getElementById("settings-packs");
    if (el) el.scrollIntoView?.({ block: "start" });
    else if (++tries < 20) setTimeout(tick, 50);
  };
  setTimeout(tick, 0);
}
