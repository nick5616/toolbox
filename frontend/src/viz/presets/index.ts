/** The curated presets (SPEC.md §6.10). PR1 adds the other 19 in its block. */
import { spectrumClassic } from "./spectrumClassic";
import type { Preset } from "./types";

export const PRESETS: readonly Preset[] = [
  spectrumClassic,
  // --- PR1 presets ---
  // --- end PR1 ---
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

export { showFromPreset } from "./types";
export type { Preset } from "./types";
