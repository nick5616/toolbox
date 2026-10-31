import type { Pipeline } from "@/lib/api";
import { presetById, showFromPreset } from "@/viz/presets";
import { parseObject } from "./steps/registry";

// Visualizer designs for pipeline steps (SPEC.md §10, §11.3). FROZEN (Wave 0).
// Templates carry only a presetId; the design itself (a Show) lives in the
// frontend, so it is filled in before a template's first Save.

export const VISUALIZER_STEP_TYPE = "visualizer";

/** The show of a preset as the ShowJSON a Visualizer step stores, or null. */
export function presetShowJson(presetId: string): string | null {
  const p = presetById(presetId);
  return p ? JSON.stringify(showFromPreset(p)) : null;
}

/** Fills showJson (and designName) of Visualizer steps that name a preset but have no design yet. */
export function fillVisualizerDesigns(p: Pipeline): Pipeline {
  const steps = (p.steps ?? []).map((s) => {
    if (s.type !== VISUALIZER_STEP_TYPE) return s;
    const o = parseObject(s.optionsJson);
    const presetId = typeof o.presetId === "string" ? o.presetId : "";
    if (!presetId || (typeof o.showJson === "string" && o.showJson !== "")) return s;
    const json = presetShowJson(presetId);
    if (!json) return s;
    const name = presetById(presetId)?.name ?? "";
    return { ...s, optionsJson: JSON.stringify({ ...o, showJson: json, designName: o.designName || name }) };
  });
  return { ...p, steps };
}
