/**
 * "My presets" (SPEC.md §6.10): designs the user saved, kept in the
 * Visualizer's module state as `myPresets: [{id, name, show}]` (the
 * VisualsPicker reads the same list). At most 50 designs, 512 KiB each; the
 * whole module state is capped at 64 KB by the settings store, so in practice
 * a handful of designs fit and adding one that doesn't says so.
 */
import { create } from "zustand";
import { validateShow } from "@/viz/validate";
import type { Show } from "@/viz/types";
import { patchVizState, readVizState } from "../vizState";

export { MAX_STATE_BYTES } from "../vizState";
export const MAX_MY_PRESETS = 50;
export const MAX_PRESET_BYTES = 512 * 1024;
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

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

function newId(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/** Checks a design can be kept; returns the reason it can't, or null. */
export function presetProblem(show: Show, existing: MyPreset[]): string | null {
  const json = JSON.stringify(show);
  if (json.length > MAX_PRESET_BYTES) return "This design is too large to save.";
  const v = validateShow(show);
  if (!v.ok) return `This design can't be saved: ${v.problem}`;
  if (existing.length >= MAX_MY_PRESETS) return `You can keep ${MAX_MY_PRESETS} presets. Delete one first.`;
  const total = existing.reduce((n, p) => n + JSON.stringify(p.show).length, json.length);
  if (total > MAX_TOTAL_BYTES) return "Your saved presets are using too much space. Delete one first.";
  return null;
}

const plain = (items: MyPreset[]) => items.map((p) => ({ id: p.id, name: p.name, show: p.show }));

export const useMyPresets = create<MyPresetsState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    if (get().loaded) return;
    const state = await readVizState();
    const list = Array.isArray(state.myPresets) ? (state.myPresets as unknown[]) : [];
    const items: MyPreset[] = [];
    for (const raw of list.slice(0, MAX_MY_PRESETS)) {
      const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
      const v = validateShow(o.show);
      if (!v.ok) continue;
      items.push({ id: typeof o.id === "string" && o.id ? o.id : newId(), name: typeof o.name === "string" && o.name ? o.name : v.show.name || "My preset", show: v.show });
    }
    set({ items, loaded: true });
  },
  async add(show) {
    const problem = presetProblem(show, get().items);
    if (problem) return problem;
    const preset: MyPreset = { id: newId(), name: show.name.trim() || "My preset", show: { ...structuredClone(show), presetId: null } };
    const items = [preset, ...get().items];
    const err = await patchVizState({ myPresets: plain(items) });
    if (err) return err;
    set({ items });
    return null;
  },
  async rename(id, name) {
    const clean = name.trim();
    if (!clean) return;
    const items = get().items.map((p) => (p.id === id ? { ...p, name: clean, show: { ...p.show, name: clean } } : p));
    set({ items });
    await patchVizState({ myPresets: plain(items) });
  },
  async remove(id) {
    const items = get().items.filter((p) => p.id !== id);
    set({ items });
    await patchVizState({ myPresets: plain(items) });
  },
}));
