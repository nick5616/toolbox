import { useMemo } from "react";
import { create } from "zustand";
import {
  LibraryService,
  LibrarySort,
  OutputKind,
  type LibraryFolder,
  type LibraryPlaces,
  type LibraryQuery,
  type Output,
  type OutputQuery,
} from "@/lib/api";
import { toAppError } from "@/lib/errors";

export type OutputView = Output & { tags: string[] };

export function normalizeOutput(o: Output): OutputView {
  return { ...o, tags: o.tags ?? [] };
}

export type LibraryViewMode = "grid" | "list" | "folders" | "bytool" | "things";
export type CardSize = "s" | "m" | "l";
export type TypeChip = "all" | "audio" | "video" | "image" | "document" | "other";
export type DateRange = "all" | "today" | "week" | "month";

export interface LibraryFilters {
  search: string;
  moduleId: string;
  type: TypeChip;
  range: DateRange;
  sort: LibrarySort;
}

export const DEFAULT_FILTERS: LibraryFilters = { search: "", moduleId: "", type: "all", range: "all", sort: LibrarySort.SortNewest };

const DAY = 86_400_000;

/** The server query for the Library's filters (`now` is injectable for tests). */
export function buildQuery(f: LibraryFilters, folder = "", limit = 100, now = Date.now()): LibraryQuery {
  let since = 0;
  if (f.range === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    since = d.getTime();
  } else if (f.range === "week") since = now - 7 * DAY;
  else if (f.range === "month") since = now - 30 * DAY;
  const kinds: OutputKind[] =
    f.type === "all"
      ? []
      : f.type === "audio"
        ? [OutputKind.KindAudio]
        : f.type === "video"
          ? [OutputKind.KindVideo]
          : f.type === "image"
            ? [OutputKind.KindImage]
            : f.type === "document"
              ? [OutputKind.KindDocument]
              : [OutputKind.KindOther];
  return { moduleId: f.moduleId, search: f.search, kinds, exts: [], since, until: 0, sort: f.sort, folder, limit, cursor: "" };
}

export function isNotImplemented(e: unknown): boolean {
  return toAppError(e).code === "not_implemented";
}

/** Where the Library should land (a deep link from a tool, a toast or the palette). */
export interface LibraryTarget {
  /** Filter to one tool's results. */
  moduleId?: string;
  /** Select a file (output or unregistered library file). */
  path?: string;
  outputId?: string;
}

const PREFS_KEY = "toolbox.library";

interface Prefs {
  view: LibraryViewMode;
  size: CardSize;
}

function loadPrefs(): Prefs {
  const fallback: Prefs = { view: "grid", size: "m" };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<Prefs>;
    const view = p.view === "grid" || p.view === "list" || p.view === "folders" || p.view === "bytool" || p.view === "things" ? p.view : fallback.view;
    const size = p.size === "s" || p.size === "m" || p.size === "l" ? p.size : fallback.size;
    return { view, size };
  } catch {
    return fallback;
  }
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* private mode: not remembered */
  }
}

/** Does an output match the filters (for a live `library:added`)? */
export function matchesFilters(o: Output, f: LibraryFilters, now = Date.now()): boolean {
  if (f.moduleId && o.moduleId !== f.moduleId) return false;
  if (f.search && !o.name.toLowerCase().includes(f.search.toLowerCase())) return false;
  const q = buildQuery(f, "", 1, now);
  if ((q.kinds ?? []).length > 0 && !(q.kinds ?? []).includes(o.kind)) return false;
  if (q.since && o.createdAt < q.since) return false;
  return true;
}

interface LibraryState {
  /** Recent outputs across all modules, newest first. Tools read this (`useRecentOutputs`); the Library view has its own list. */
  items: OutputView[];
  nextCursor: string;
  loading: boolean;

  // --- the Library view (Phase 19) ---
  view: LibraryViewMode;
  size: CardSize;
  filters: LibraryFilters;
  /** The folder selected in the Folders view (library-relative, "" = root). */
  folder: string;
  /** The filtered list for the Grid, List and By tool views. */
  list: OutputView[];
  listNext: string;
  listLoading: boolean;
  /** The server's Library methods aren't there yet: the list fell back to Recent. */
  unavailable: boolean;
  /** A deep link waiting for the view to select it. */
  target: (LibraryTarget & { nonce: number }) | null;
  folders: LibraryFolder | null;
  foldersUnavailable: boolean;
  places: LibraryPlaces | null;
  placesUnavailable: boolean;

  setPage: (items: Output[], nextCursor: string) => void;
  add: (o: Output) => void;
  removeLocal: (ids: string[]) => void;
  /** Swaps a renamed output in everywhere. */
  replaceLocal: (o: Output) => void;

  /** Replaces items with the first page for q. */
  refresh: (q?: Partial<OutputQuery>) => Promise<void>;
  /** Appends the next page (same filters as the last refresh). */
  loadMore: () => Promise<void>;
  remove: (id: string) => Promise<void>;

  setView: (v: LibraryViewMode) => void;
  setSize: (s: CardSize) => void;
  setFilters: (patch: Partial<LibraryFilters>) => void;
  setFolder: (rel: string) => void;
  /** Runs the server query for the current filters (first page). */
  query: () => Promise<void>;
  loadMoreList: () => Promise<void>;
  loadFolders: () => Promise<void>;
  loadPlaces: () => Promise<void>;
  /** Sets the view, filter and selection for a deep link. */
  applyLink: (t: LibraryTarget) => void;
  clearTarget: () => void;
}

let lastQuery: OutputQuery = { moduleId: "", search: "", limit: 100, cursor: "" };
let nonce = 0;
let queryToken = 0;

const prefs0 = loadPrefs();

function listLimit(view: LibraryViewMode): number {
  return view === "bytool" ? 500 : 100;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  items: [],
  nextCursor: "",
  loading: false,

  view: prefs0.view,
  size: prefs0.size,
  filters: { ...DEFAULT_FILTERS },
  folder: "",
  list: [],
  listNext: "",
  listLoading: false,
  unavailable: false,
  target: null,
  folders: null,
  foldersUnavailable: false,
  places: null,
  placesUnavailable: false,

  setPage: (items, nextCursor) => {
    const list = items.map(normalizeOutput);
    set({ items: list, nextCursor, list, listNext: nextCursor });
  },
  add: (o) =>
    set((s) => {
      const n = normalizeOutput(o);
      const lq = lastQuery;
      const patch: Partial<LibraryState> = {};
      if (!(lq.moduleId && o.moduleId !== lq.moduleId)) {
        patch.items = [n, ...s.items.filter((x) => x.id !== o.id && x.path !== o.path)];
      }
      // The Library list takes it when it matches the filters and no older page hides it (newest sort only).
      if (matchesFilters(o, s.filters) && s.filters.sort === LibrarySort.SortNewest) {
        patch.list = [n, ...s.list.filter((x) => x.id !== o.id && x.path !== o.path)];
      }
      return patch;
    }),
  removeLocal: (ids) => set((s) => ({ items: s.items.filter((x) => !ids.includes(x.id)), list: s.list.filter((x) => !ids.includes(x.id)) })),
  replaceLocal: (o) =>
    set((s) => {
      const n = normalizeOutput(o);
      const swap = (xs: OutputView[]) => xs.map((x) => (x.id === o.id ? n : x));
      return { items: swap(s.items), list: swap(s.list) };
    }),

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

  setView: (view) => {
    set({ view });
    savePrefs({ view, size: get().size });
  },
  setSize: (size) => {
    set({ size });
    savePrefs({ view: get().view, size });
  },
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  setFolder: (folder) => set({ folder }),

  query: async () => {
    const { filters, view } = get();
    const token = ++queryToken;
    set({ listLoading: true });
    try {
      const page = await LibraryService.Query(buildQuery(filters, "", listLimit(view)));
      if (token !== queryToken) return;
      set({ list: (page.items ?? []).map(normalizeOutput), listNext: page.nextCursor, unavailable: false });
    } catch (e) {
      if (token !== queryToken) return;
      if (!isNotImplemented(e)) {
        set({ listLoading: false });
        throw e;
      }
      // Fall back to Recent with the filters it knows; the rest is applied here.
      const page = await LibraryService.Recent({ moduleId: filters.moduleId, search: filters.search, limit: 100, cursor: "" });
      if (token !== queryToken) return;
      const now = Date.now();
      const list = (page.items ?? []).map(normalizeOutput).filter((o) => matchesFilters(o, filters, now));
      set({ list, listNext: page.nextCursor, unavailable: true });
    } finally {
      if (token === queryToken) set({ listLoading: false });
    }
  },
  loadMoreList: async () => {
    const { listNext, listLoading, filters, view, unavailable } = get();
    if (!listNext || listLoading) return;
    set({ listLoading: true });
    try {
      const q = buildQuery(filters, "", listLimit(view));
      const page = unavailable
        ? await LibraryService.Recent({ moduleId: filters.moduleId, search: filters.search, limit: 100, cursor: listNext })
        : await LibraryService.Query({ ...q, cursor: listNext });
      const now = Date.now();
      const more = (page.items ?? []).map(normalizeOutput).filter((o) => !unavailable || matchesFilters(o, filters, now));
      set((s) => ({ list: s.list.concat(more), listNext: page.nextCursor }));
    } finally {
      set({ listLoading: false });
    }
  },
  loadFolders: async () => {
    try {
      const root = await LibraryService.Folders();
      set({ folders: root, foldersUnavailable: false });
    } catch (e) {
      if (!isNotImplemented(e)) throw e;
      set({ folders: null, foldersUnavailable: true });
    }
  },
  loadPlaces: async () => {
    try {
      const p = await LibraryService.Places();
      set({ places: p, placesUnavailable: false });
    } catch (e) {
      if (!isNotImplemented(e)) throw e;
      set({ places: null, placesUnavailable: true });
    }
  },
  applyLink: (t) => {
    set((s) => ({
      view: s.view === "list" ? "list" : "grid",
      filters: { ...DEFAULT_FILTERS, moduleId: t.moduleId ?? "" },
      folder: "",
      target: t.path || t.outputId || t.moduleId ? { ...t, nonce: ++nonce } : null,
    }));
  },
  clearTarget: () => set({ target: null }),
}));

/** Recent outputs from the store, optionally for one module. */
export function useRecentOutputs(moduleId?: string, limit = 20): OutputView[] {
  const items = useLibrary((s) => s.items);
  return useMemo(
    () => (moduleId ? items.filter((o) => o.moduleId === moduleId) : items).slice(0, limit),
    [items, moduleId, limit],
  );
}
