import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { PacksService, type PackStatus, type ToolsDirInfo } from "@/lib/api";
import { on } from "@/lib/events";
import { normalizePack, type PackView } from "@/views/setup/packSizes";
import { isActive, useJobs, type JobView } from "./jobs";

export const PACK_INSTALL_MODULE = "system-pack-install";
export const TOOLS_MOVE_MODULE = "system-tools-move";

interface PacksState {
  list: PackView[];
  byId: Record<string, PackView>;
  loaded: boolean;
  toolsDir: ToolsDirInfo | null;
  setAll: (packs: PackStatus[] | null | undefined) => void;
  setToolsDir: (t: ToolsDirInfo | null) => void;
  /** Fetches packs and the tools folder; failures leave the previous state. */
  load: () => Promise<void>;
}

export const usePacks = create<PacksState>((set, get) => ({
  list: [],
  byId: {},
  loaded: false,
  toolsDir: null,
  setAll: (packs) => {
    const list = (packs ?? []).map(normalizePack);
    set({ list, byId: Object.fromEntries(list.map((p) => [p.id, p])), loaded: true });
  },
  setToolsDir: (toolsDir) => set({ toolsDir }),
  load: async () => {
    try {
      get().setAll(await PacksService.List());
    } catch {
      /* keep what we have; packs:changed will refresh */
    }
    try {
      set({ toolsDir: await PacksService.ToolsDir() });
    } catch {
      /* unknown tools folder state: no banner */
    }
  },
}));

/** Loads packs once and keeps them in sync with `packs:changed` (main window). */
export function usePacksSync(): void {
  useEffect(() => {
    const off = on("packs:changed", (p) => {
      usePacks.getState().setAll(p.packs);
      // The tools folder may have changed (move finished, drive reconnected).
      void PacksService.ToolsDir()
        .then((t) => usePacks.getState().setToolsDir(t))
        .catch(() => undefined);
    });
    void usePacks.getState().load();
    return off;
  }, []);
}

/** Pack id an install job was submitted for (`{pack, only}` options), or "". */
export function jobPackId(j: JobView): string {
  if (j.moduleId !== PACK_INSTALL_MODULE) return "";
  try {
    const o: unknown = JSON.parse(j.optionsJson || "{}");
    if (typeof o === "object" && o !== null && typeof (o as { pack?: unknown }).pack === "string") {
      return (o as { pack: string }).pack;
    }
  } catch {
    /* malformed options */
  }
  return "";
}

/**
 * The newest pack-install job per pack id (created at or after `since` ms).
 * Returns a stable reference while the jobs map is unchanged.
 */
export function useLatestPackJobs(since = 0): Record<string, JobView> {
  const byId = useJobs((s) => s.byId);
  return useMemo(() => {
    const out: Record<string, JobView> = {};
    for (const j of Object.values(byId)) {
      if (j.createdAt < since) continue;
      const id = jobPackId(j);
      if (!id) continue;
      const prev = out[id];
      if (!prev || j.createdAt >= prev.createdAt) out[id] = j;
    }
    return out;
  }, [byId, since]);
}

/** True if any pack has an active install job. */
export function useAnyPackInstalling(): boolean {
  const byId = useJobs((s) => s.byId);
  return useMemo(() => Object.values(byId).some((j) => jobPackId(j) !== "" && isActive(j)), [byId]);
}
