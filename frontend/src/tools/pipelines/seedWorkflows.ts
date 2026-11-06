/**
 * Phase 15: the workflow templates also arrive as ready-made saved pipelines,
 * once, so they can be switched between from the pipeline picker straight
 * away ("make all the pipelines i can switch between"). Deleting one later
 * doesn't bring it back: a module-state flag records that the seed ran.
 */
import { PipelinesService, SettingsService } from "@/lib/api";
import { currentWindow } from "@/lib/windows";
import { usePipelines } from "@/state/pipelines";

export const SEED_KEY = "pipelines.seeded-workflows";

/** The Phase 15 workflow templates, in gallery order (SPEC §1). */
export const WORKFLOW_TEMPLATES = [
  "read-it-to-me",
  "audiobook",
  "tight-lecture",
  "podcast-polish",
  "camera-roll",
  "shop-shots",
  "storyboard",
  "meeting-minutes",
  "link-to-notes",
  "highlight-reel",
  "reaction-gif",
  "narrated-slideshow",
  "song-everything",
  "vertical-cut",
] as const;

let started = false;

/** Saves each workflow template as a pipeline the first time Pipelines opens (main window only). */
export async function seedWorkflowPipelines(): Promise<number> {
  if (started || currentWindow().kind !== "main") return 0;
  started = true;
  const done = await SettingsService.ModuleState(SEED_KEY).catch(() => "");
  if (done) return 0;
  const have = new Set(usePipelines.getState().entries.map((e) => e.pipeline.templateId));
  let made = 0;
  for (const id of WORKFLOW_TEMPLATES) {
    if (have.has(id)) continue;
    try {
      const p = await PipelinesService.FromTemplate(id);
      await PipelinesService.Save(p);
      made++;
    } catch {
      // A template this build doesn't have (or can't save) is skipped; the gallery still offers the rest.
    }
  }
  await SettingsService.SetModuleState(SEED_KEY, String(Date.now())).catch(() => undefined);
  if (made > 0) await usePipelines.getState().load().catch(() => undefined);
  return made;
}

/** Tests only. */
export function resetSeedForTest(): void {
  started = false;
}
