import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
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
    // Independent calls: run together, apply each result as it lands.
    await Promise.all([
      PacksService.List().then(
        (packs) => get().setAll(packs),
        () => undefined, // keep what we have; packs:changed will refresh
      ),
      PacksService.ToolsDir().then(
        (toolsDir) => set({ toolsDir }),
        () => undefined, // unknown tools folder state: no banner
      ),
    ]);
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

const packIdCache = new Map<string, string>();
const PACK_ID_CACHE_MAX = 256;

function parsePackId(optionsJson: string): string {
  try {
    const o: unknown = JSON.parse(optionsJson || "{}");
    if (typeof o === "object" && o !== null && typeof (o as { pack?: unknown }).pack === "string") {
      return (o as { pack: string }).pack;
    }
  } catch {
    /* malformed options */
  }
  return "";
}

/** Pack id an install job was submitted for (`{pack, only}` options), or "". Parsed once per options string. */
export function jobPackId(j: JobView): string {
  if (j.moduleId !== PACK_INSTALL_MODULE) return "";
  const key = j.optionsJson;
  const hit = packIdCache.get(key);
  if (hit !== undefined) return hit;
  const id = parsePackId(key);
  if (packIdCache.size >= PACK_ID_CACHE_MAX) packIdCache.clear();
  packIdCache.set(key, id);
  return id;
}

/** The newest pack-install job per pack id (created at or after `since` ms). */
export function latestPackJobs(byId: Record<string, JobView>, since: number): Record<string, JobView> {
  const out: Record<string, JobView> = {};
  for (const j of Object.values(byId)) {
    if (j.createdAt < since) continue;
    const id = jobPackId(j);
    if (!id) continue;
    const prev = out[id];
    if (!prev || j.createdAt >= prev.createdAt) out[id] = j;
  }
  return out;
}

/**
 * The newest pack-install job per pack id (created at or after `since` ms).
 * Shallow-stable: the same reference until one of those jobs actually changes.
 */
export function useLatestPackJobs(since = 0): Record<string, JobView> {
  return useJobs(useShallow((s) => latestPackJobs(s.byId, since)));
}

/** True if any pack has an active install job. */
export function useAnyPackInstalling(): boolean {
  return useJobs((s) => Object.values(s.byId).some((j) => isActive(j) && jobPackId(j) !== ""));
}
