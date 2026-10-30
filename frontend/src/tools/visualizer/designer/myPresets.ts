/**
 * "My presets" (SPEC.md §6.10): designs the user saved. They are kept by Go
 * in their own file (VisualizerService.Designs/SaveDesign/RenameDesign/
 * DeleteDesign: at most 50, 512 KiB each), which the VisualsPicker reads too.
 */
import { create } from "zustand";
import { VisualizerService, type VisualizerDesign } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { validateShow } from "@/viz/validate";
import type { Show } from "@/viz/types";

export const MAX_MY_PRESETS = 50;
export const MAX_PRESET_BYTES = 512 * 1024;

export interface MyPreset {
  id: string;
  name: string;
  show: Show;
}

interface MyPresetsState {
  items: MyPreset[];
  loaded: boolean;
  load(): Promise<void>;
  /** Returns an error message, or null when saved. */
  add(show: Show): Promise<string | null>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Checks a design can be kept; returns the reason it can't, or null. */
export function presetProblem(show: Show, existing: MyPreset[]): string | null {
  if (JSON.stringify(show).length > MAX_PRESET_BYTES) return "This design is too large to save.";
  const v = validateShow(show);
  if (!v.ok) return `This design can't be saved: ${v.problem}`;
  if (existing.length >= MAX_MY_PRESETS) return `You can keep ${MAX_MY_PRESETS} presets. Delete one first.`;
  return null;
}

function fromDesign(d: VisualizerDesign): MyPreset | null {
  let raw: unknown;
  try {
    raw = JSON.parse(d.showJson);
  } catch {
    return null;
  }
  const v = validateShow(raw);
  return v.ok ? { id: d.id, name: d.name || v.show.name || "My preset", show: v.show } : null;
}

export const useMyPresets = create<MyPresetsState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    if (get().loaded) return;
    try {
      const list = (await VisualizerService.Designs()) ?? [];
      set({ items: list.map(fromDesign).filter((p): p is MyPreset => p !== null), loaded: true });
    } catch {
      set({ items: [], loaded: true });
    }
  },
  async add(show) {
    const problem = presetProblem(show, get().items);
    if (problem) return problem;
    const name = show.name.trim() || "My preset";
    const stored = { ...structuredClone(show), name, presetId: null };
    try {
      const d = await VisualizerService.SaveDesign({ id: "", name, showJson: JSON.stringify(stored), updatedMs: 0 });
      set({ items: [{ id: d.id, name: d.name, show: stored }, ...get().items] });
      return null;
    } catch (e) {
      return toAppError(e).message;
    }
  },
  async rename(id, name) {
    const clean = name.trim();
    if (!clean) return;
    set({ items: get().items.map((p) => (p.id === id ? { ...p, name: clean, show: { ...p.show, name: clean } } : p)) });
    await VisualizerService.RenameDesign(id, clean).catch(() => undefined);
  },
  async remove(id) {
    set({ items: get().items.filter((p) => p.id !== id) });
    await VisualizerService.DeleteDesign(id).catch(() => undefined);
  },
}));
