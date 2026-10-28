import { create } from "zustand";
import { ModuleStatus, type Descriptor } from "@/lib/api";

/** Descriptor with Go's nullable slices normalised to arrays. */
export type ModuleView = Descriptor & {
  requires: string[];
  recommends: string[];
  accepts: { extensions: string[]; urls: boolean; any: boolean };
};

export function normalizeModule(d: Descriptor): ModuleView {
  return {
    ...d,
    requires: d.requires ?? [],
    recommends: d.recommends ?? [],
    accepts: { extensions: d.accepts.extensions ?? [], urls: d.accepts.urls, any: d.accepts.any },
  };
}

interface ModulesState {
  list: ModuleView[];
  byId: Record<string, ModuleView>;
  setAll: (list: Descriptor[]) => void;
}

export const useModules = create<ModulesState>((set) => ({
  list: [],
  byId: {},
  setAll: (list) => {
    const views = list.map(normalizeModule);
    set({ list: views, byId: Object.fromEntries(views.map((m) => [m.id, m])) });
  },
}));

export function isReady(m: Descriptor): boolean {
  return m.status === ModuleStatus.StatusReady;
}

export function useModule(id: string): ModuleView | undefined {
  return useModules((s) => s.byId[id]);
}
