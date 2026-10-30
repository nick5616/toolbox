/**
 * "My presets" (SPEC.md §6.10): designs the user saved. They live in module
 * state, one entry per design. The settings store caps one module-state value
 * at 64 KB, so the index is `visualizer.myPresets` and every design is its own
 * `visualizer.preset.<id>` entry (a design above the cap can't be saved and
 * says so). At most 50 designs.
 */
import { create } from "zustand";
import { SettingsService } from "@/lib/api";
import { validateShow } from "@/viz/validate";
import type { Show } from "@/viz/types";

export const MY_PRESETS_KEY = "visualizer.myPresets";
export const MY_PRESET_PREFIX = "visualizer.preset.";
export const MAX_MY_PRESETS = 50;
/** The most one stored value can hold (core.MaxModuleStateBytes). */
export const MAX_STATE_BYTES = 64 * 1024;
export const MAX_PRESET_BYTES = 512 * 1024;
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

export interface MyPreset {
  id: string;
  name: string;
  show: Show;
}

interface Index {
  items: Array<{ id: string; name: string }>;
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

async function writeIndex(items: MyPreset[]): Promise<void> {
  const index: Index = { items: items.map((i) => ({ id: i.id, name: i.name })) };
  await SettingsService.SetModuleState(MY_PRESETS_KEY, JSON.stringify(index));
}

/** Checks a design can be kept; returns the reason it can't, or null. */
export function presetProblem(show: Show, existing: MyPreset[]): string | null {
  const json = JSON.stringify(show);
  if (json.length > MAX_PRESET_BYTES) return "This design is too large to save.";
  if (json.length > MAX_STATE_BYTES) return "This design is too large to keep as a preset. Remove a few layers and try again.";
  const v = validateShow(show);
  if (!v.ok) return `This design can't be saved: ${v.problem}`;
  if (existing.length >= MAX_MY_PRESETS) return `You can keep ${MAX_MY_PRESETS} presets. Delete one first.`;
  const total = existing.reduce((n, p) => n + JSON.stringify(p.show).length, json.length);
  if (total > MAX_TOTAL_BYTES) return "Your saved presets are using too much space. Delete one first.";
  return null;
}

export const useMyPresets = create<MyPresetsState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    if (get().loaded) return;
    try {
      const raw = await SettingsService.ModuleState(MY_PRESETS_KEY);
      const index = raw ? (JSON.parse(raw) as Index) : { items: [] };
      const list = Array.isArray(index.items) ? index.items.slice(0, MAX_MY_PRESETS) : [];
      const loaded = await Promise.all(
        list.map(async (it): Promise<MyPreset | null> => {
          try {
            const body = await SettingsService.ModuleState(MY_PRESET_PREFIX + it.id);
            if (!body) return null;
            const v = validateShow(JSON.parse(body) as unknown);
            return v.ok ? { id: it.id, name: String(it.name), show: v.show } : null;
          } catch {
            return null;
          }
        }),
      );
      set({ items: loaded.filter((x): x is MyPreset => x !== null), loaded: true });
    } catch {
      set({ items: [], loaded: true });
    }
  },
  async add(show) {
    const problem = presetProblem(show, get().items);
    if (problem) return problem;
    const preset: MyPreset = { id: newId(), name: show.name.trim() || "My preset", show: { ...structuredClone(show), presetId: null } };
    try {
      await SettingsService.SetModuleState(MY_PRESET_PREFIX + preset.id, JSON.stringify(preset.show));
      const items = [preset, ...get().items];
      await writeIndex(items);
      set({ items });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Couldn't save the preset.";
    }
  },
  async rename(id, name) {
    const clean = name.trim();
    if (!clean) return;
    const items = get().items.map((p) => (p.id === id ? { ...p, name: clean, show: { ...p.show, name: clean } } : p));
    set({ items });
    const hit = items.find((p) => p.id === id);
    try {
      if (hit) await SettingsService.SetModuleState(MY_PRESET_PREFIX + id, JSON.stringify(hit.show));
      await writeIndex(items);
    } catch {
      /* the list in memory is still right; the next change retries */
    }
  },
  async remove(id) {
    const items = get().items.filter((p) => p.id !== id);
    set({ items });
    try {
      await writeIndex(items);
      await SettingsService.SetModuleState(MY_PRESET_PREFIX + id, "null"); // there is no delete; null reads as empty
    } catch {
      /* ignore */
    }
  },
}));
