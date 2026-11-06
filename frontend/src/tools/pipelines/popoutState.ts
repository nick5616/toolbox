/**
 * Popping the Pipelines tool out into its own window (Phase 11, SPEC §5.6): the
 * shell awaits `flushForPopOut` first, so the new window reopens the same
 * pipeline. A dirty draft is saved; one that can't be saved yet (the save
 * failed) is kept in the module's remembered state and restored on open.
 */
import { useEffect } from "react";
import type { Pipeline } from "@/lib/api";
import { SettingsService } from "@/lib/api";
import { useBeforePopOut } from "@/lib/popout";
import { usePipelines } from "@/state/pipelines";
import { stashDraft, useDraft } from "./draftStore";

export const MODULE_ID = "pipelines";

interface Remembered {
  pipelineId?: string;
  /** An unsaved draft of `pipelineId` (only when it couldn't be saved). */
  draft?: Pipeline;
}

/** Saves the open draft (or remembers it when the save fails) and remembers which pipeline was open. */
export async function flushForPopOut(): Promise<void> {
  const s = useDraft.getState();
  if (!s.draft || !s.pipelineId) return;
  await s.flush();
  const after = useDraft.getState();
  const remembered: Remembered = { pipelineId: s.pipelineId };
  if (after.dirty && after.draft) remembered.draft = after.draft;
  await SettingsService.SetModuleState(MODULE_ID, JSON.stringify(remembered)).catch(() => undefined);
}

/** Mount once in the Pipelines view: registers the pop-out flush and reopens the remembered pipeline. */
export function usePopOutState(): void {
  useBeforePopOut(MODULE_ID, flushForPopOut);
  const loaded = usePipelines((s) => s.loaded);
  useEffect(() => {
    if (!loaded) return;
    let off = false;
    void (async () => {
      let r: Remembered = {};
      try {
        const raw = await SettingsService.ModuleState(MODULE_ID);
        if (raw) r = JSON.parse(raw) as Remembered;
      } catch {
        return;
      }
      if (off || !r.pipelineId) return;
      const p = usePipelines.getState();
      if (p.selectedPipelineId || !p.entries.some((e) => e.pipeline.id === r.pipelineId)) return;
      if (r.draft && r.draft.id === r.pipelineId) stashDraft(r.draft);
      p.selectPipeline(r.pipelineId);
      // Consumed: later opens start from the saved pipeline.
      await SettingsService.SetModuleState(MODULE_ID, JSON.stringify({})).catch(() => undefined);
    })();
    return () => {
      off = true;
    };
  }, [loaded]);
}
