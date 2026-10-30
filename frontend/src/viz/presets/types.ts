import type { Show } from "../types";

export interface Preset {
  id: string;
  name: string;
  description: string; // one line, shown on the card
  bestFor: string;
  /** Offered first for "Over the video" (SPEC.md §6.10). */
  overlayFirst?: boolean;
  show: Show;
}

/** A fresh copy of a preset's show (presets are never mutated). */
export function showFromPreset(p: Preset): Show {
  return structuredClone(p.show);
}
