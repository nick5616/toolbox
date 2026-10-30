/**
 * The Visualizer's module state, one JSON object under module id "visualizer"
 * (shared with the VisualsPicker, which reads `myPresets`). Writers merge their
 * keys into the stored object so they never clobber each other; writes are
 * serialised. The store caps a module's state at 64 KB.
 */
import { SettingsService } from "@/lib/api";

export const VIZ_MODULE = "visualizer";
/** core.MaxModuleStateBytes. */
export const MAX_STATE_BYTES = 64 * 1024;

let chain: Promise<unknown> = Promise.resolve();

export async function readVizState(): Promise<Record<string, unknown>> {
  try {
    const raw = await SettingsService.ModuleState(VIZ_MODULE);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Merges `patch` into the stored state. Returns an error message, or null when saved. */
export function patchVizState(patch: Record<string, unknown>): Promise<string | null> {
  const run = async (): Promise<string | null> => {
    const next = { ...(await readVizState()), ...patch };
    const json = JSON.stringify(next);
    if (json.length > MAX_STATE_BYTES) return "There isn't room to keep this. The app keeps up to 64 KB of saved designs and settings for the Visualizer; delete a saved preset first.";
    try {
      await SettingsService.SetModuleState(VIZ_MODULE, json);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Couldn't save.";
    }
  };
  const p = chain.then(run, run);
  chain = p;
  return p;
}
