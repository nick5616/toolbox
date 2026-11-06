import { create } from "zustand";
import type { FileInfo } from "@/lib/api";

/** Embedded instances keep their lists only for the most recent keys. */
export const MAX_EMBED_KEYS = 20;

interface FileInputsState {
  /** Input lists by instance key (module id, or an embed key). In memory only. */
  lists: Record<string, FileInfo[]>;
  /** Embed keys, least recently used first. */
  embedKeys: string[];
  set: (key: string, files: FileInfo[]) => void;
  reset: () => void;
}

const EMBED_PREFIX = "embed:";

export const useFileInputsStore = create<FileInputsState>((set) => ({
  lists: {},
  embedKeys: [],
  set: (key, files) =>
    set((s) => {
      const lists = { ...s.lists, [key]: files };
      let embedKeys = s.embedKeys;
      if (key.startsWith(EMBED_PREFIX)) {
        embedKeys = [...embedKeys.filter((k) => k !== key), key];
        while (embedKeys.length > MAX_EMBED_KEYS) {
          const old = embedKeys[0];
          embedKeys = embedKeys.slice(1);
          if (old !== undefined) delete lists[old];
        }
      }
      return { lists, embedKeys };
    }),
  reset: () => set({ lists: {}, embedKeys: [] }),
}));

/** The store key of a tool instance: the module id, or a per-embed key. */
export function fileInputsKey(moduleId: string, embed: { host: string; placement: string; token?: string } | null): string {
  if (!embed) return moduleId;
  return `${EMBED_PREFIX}${embed.host}:${moduleId}:${embed.placement}:${embed.token ?? ""}`;
}
