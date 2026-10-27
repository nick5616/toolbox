import { useMemo } from "react";
import { create } from "zustand";
import { LibraryService, type Output, type OutputQuery } from "@/lib/api";

export type OutputView = Output & { tags: string[] };

export function normalizeOutput(o: Output): OutputView {
  return { ...o, tags: o.tags ?? [] };
}

interface LibraryState {
  /** Recent outputs across all modules, newest first. */
  items: OutputView[];
  nextCursor: string;
  loading: boolean;

  setPage: (items: Output[], nextCursor: string) => void;
  add: (o: Output) => void;
  removeLocal: (ids: string[]) => void;

  /** Replaces items with the first page for q. */
  refresh: (q?: Partial<OutputQuery>) => Promise<void>;
  /** Appends the next page (same filters as the last refresh). */
  loadMore: () => Promise<void>;
  remove: (id: string) => Promise<void>;
}

let lastQuery: OutputQuery = { moduleId: "", search: "", limit: 100, cursor: "" };

export const useLibrary = create<LibraryState>((set, get) => ({
  items: [],
  nextCursor: "",
  loading: false,

  setPage: (items, nextCursor) => set({ items: items.map(normalizeOutput), nextCursor }),
  add: (o) =>
    set((s) => {
      if (lastQuery.moduleId && o.moduleId !== lastQuery.moduleId) return s;
      const rest = s.items.filter((x) => x.id !== o.id && x.path !== o.path);
      return { items: [normalizeOutput(o), ...rest] };
    }),
  removeLocal: (ids) => set((s) => ({ items: s.items.filter((x) => !ids.includes(x.id)) })),

  refresh: async (q = {}) => {
    lastQuery = { moduleId: "", search: "", limit: 100, ...q, cursor: "" };
    set({ loading: true });
    try {
      const page = await LibraryService.Recent(lastQuery);
      set({ items: (page.items ?? []).map(normalizeOutput), nextCursor: page.nextCursor });
    } finally {
      set({ loading: false });
    }
  },
  loadMore: async () => {
    const cursor = get().nextCursor;
    if (!cursor || get().loading) return;
    set({ loading: true });
    try {
      const page = await LibraryService.Recent({ ...lastQuery, cursor });
      set((s) => ({
        items: s.items.concat((page.items ?? []).map(normalizeOutput)),
        nextCursor: page.nextCursor,
      }));
    } finally {
      set({ loading: false });
    }
  },
  remove: async (id) => {
    await LibraryService.Remove(id);
    get().removeLocal([id]);
  },
}));

/** Recent outputs from the store, optionally for one module. */
export function useRecentOutputs(moduleId?: string, limit = 20): OutputView[] {
  const items = useLibrary((s) => s.items);
  return useMemo(
    () => (moduleId ? items.filter((o) => o.moduleId === moduleId) : items).slice(0, limit),
    [items, moduleId, limit],
  );
}
