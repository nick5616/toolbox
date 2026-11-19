import { useEffect } from "react";
import { create } from "zustand";
import {
  SearchService,
  type LabelCount,
  type LibraryQuery,
  type MediaLabel,
  type MediaText,
  type SearchHit,
  type SearchSettings,
  type SearchStatus,
} from "@/lib/api";
import { on } from "@/lib/events";

/** Smart search's client state (Phase 20, SPEC §1.1): status, settings, the current query's result and the per-file caches. */

export interface HitView extends Omit<SearchHit, "via" | "moments"> {
  via: string[];
  moments: number[];
}

export interface SearchPageView {
  hits: HitView[];
  labels: LabelCount[];
  concept: boolean;
  warming: boolean;
}

export interface SimilarTo {
  path: string;
  pos: number;
  name: string;
}

export const EMPTY_STATUS: SearchStatus = {
  installed: false,
  enabled: false,
  paused: false,
  waiting: false,
  total: 0,
  done: 0,
  pending: 0,
  failed: 0,
  skipped: 0,
  speechPending: 0,
  speechDone: 0,
  stage: "",
  current: "",
  model: "",
  indexBytes: 0,
  lastError: "",
};

export const DEFAULT_SETTINGS: SearchSettings = { enabled: true, paused: false, readText: true, speech: true, speechMaxMin: 60, skip: [] };

export function normalizeHit(h: SearchHit): HitView {
  return { ...h, via: h.via ?? [], moments: h.moments ?? [] };
}

/** Strength order for the merge (name-only matches come after every scored hit). */
const TIER: Record<string, number> = { label: 0, strong: 1, good: 2, maybe: 3, name: 4 };

export function hitKey(h: Pick<HitView, "path" | "source" | "projectId" | "output">): string {
  if (h.output) return h.output.id;
  if (h.source === "project") return `project:${h.projectId}`;
  return `path:${h.path}`;
}

/**
 * Merges a later answer to the same query into the list on screen. The new
 * answer decides the order; a hit the user is working with (`keepKey`, the
 * selection) that the new answer no longer has stays where its tier ends, so
 * nothing the user holds is pulled away.
 */
export function mergeHits(prev: readonly HitView[], next: readonly HitView[], keepKey = ""): HitView[] {
  if (!keepKey || next.some((h) => hitKey(h) === keepKey)) return next.slice();
  const kept = prev.find((h) => hitKey(h) === keepKey);
  if (!kept) return next.slice();
  const tier = TIER[kept.strength] ?? 4;
  let at = next.length;
  for (let i = 0; i < next.length; i++) {
    if ((TIER[next[i]?.strength ?? "name"] ?? 4) > tier) {
      at = i;
      break;
    }
  }
  return [...next.slice(0, at), kept, ...next.slice(at)];
}

/** Two requests that differ only in time (a warming re-query) merge; different ones replace. */
function requestKey(text: string, labels: readonly string[], similar: SimilarTo | null, filter: LibraryQuery): string {
  return JSON.stringify([text.trim().toLowerCase(), labels, similar?.path ?? "", similar?.pos ?? 0, filter.kinds, filter.moduleId, filter.since, filter.folder]);
}

interface LastRequest {
  text: string;
  filter: LibraryQuery;
  key: string;
}

const WARM_MIN_MS = 60_000;
let lastWarm = 0;
let queryToken = 0;
let lastRequest: LastRequest | null = null;

interface SearchState {
  status: SearchStatus;
  statusLoaded: boolean;
  settings: SearchSettings | null;

  /** Label chips narrowing the query (vocabulary ids or the user's text). */
  labels: string[];
  /** Display names of the label filters (the chip keeps its name when the answer no longer lists it). */
  labelNames: Record<string, string>;
  similar: SimilarTo | null;
  page: SearchPageView | null;
  loading: boolean;
  /** The text of the answer on screen. */
  answeredText: string;

  things: LabelCount[] | null;
  thingsLoading: boolean;
  /** Bumped on `search:indexed`: things and the per-file panels reload. */
  indexedVersion: number;

  labelCache: Record<string, MediaLabel[]>;
  textCache: Record<string, MediaText[]>;

  /** The Library's selected file (the palette's "Find similar to selected"). */
  selectedPath: string;
  selectedPos: number;
  /** A palette command asked for the search box. */
  focusPending: boolean;

  setStatus: (s: SearchStatus) => void;
  loadStatus: () => Promise<void>;
  loadSettings: () => Promise<SearchSettings>;
  saveSettings: (patch: Partial<SearchSettings>) => Promise<void>;

  /** Runs a query; `keepKey` is the selected hit's key, kept through a merge. */
  run: (text: string, filter: LibraryQuery, keepKey?: string) => Promise<void>;
  /** Re-asks the last query after the text vector became ready. */
  onReady: (text: string, keepKey?: string) => Promise<void>;
  clearResults: () => void;
  toggleLabel: (label: string, display?: string) => void;
  /** Adds a label filter (no-op when it is already on). */
  addLabel: (label: string, display?: string) => void;
  clearLabels: () => void;
  setSimilar: (s: SimilarTo | null) => void;

  loadThings: () => Promise<void>;
  loadLabels: (path: string) => Promise<MediaLabel[]>;
  setLabel: (path: string, label: string, on: boolean) => Promise<void>;
  loadTexts: (path: string) => Promise<MediaText[]>;
  invalidate: (paths: readonly string[]) => void;

  setSelected: (path: string, pos?: number) => void;
  requestFocus: () => void;
  consumeFocus: () => boolean;
  warm: () => void;
}

export const useSearch = create<SearchState>((set, get) => ({
  status: EMPTY_STATUS,
  statusLoaded: false,
  settings: null,
  labels: [],
  labelNames: {},
  similar: null,
  page: null,
  loading: false,
  answeredText: "",
  things: null,
  thingsLoading: false,
  indexedVersion: 0,
  labelCache: {},
  textCache: {},
  selectedPath: "",
  selectedPos: -1,
  focusPending: false,

  setStatus: (status) => set({ status, statusLoaded: true }),
  loadStatus: async () => {
    try {
      set({ status: await SearchService.Status(), statusLoaded: true });
    } catch {
      set({ statusLoaded: true });
    }
  },
  loadSettings: async () => {
    const s = await SearchService.Settings();
    const settings = { ...s, skip: s.skip ?? [] };
    set({ settings });
    return settings;
  },
  saveSettings: async (patch) => {
    const cur = get().settings ?? (await get().loadSettings());
    const next = { ...cur, ...patch };
    set({ settings: next });
    try {
      await SearchService.SetSettings(next);
    } catch (e) {
      set({ settings: cur });
      throw e;
    }
    void get().loadStatus();
  },

  run: async (text, filter, keepKey = "") => {
    const { labels, similar } = get();
    const key = requestKey(text, labels, similar, filter);
    const same = lastRequest?.key === key;
    lastRequest = { text, filter, key };
    const token = ++queryToken;
    set({ loading: true });
    try {
      const raw = await SearchService.Query({ text: text.trim(), labels, similar: similar?.path ?? "", similarPos: similar?.pos ?? -1, filter, limit: similar ? 60 : 200 });
      if (token !== queryToken) return;
      const hits = (raw.hits ?? []).map(normalizeHit);
      const prev = get().page;
      set({
        page: { hits: same && prev ? mergeHits(prev.hits, hits, keepKey) : hits, labels: raw.labels ?? [], concept: raw.concept, warming: raw.warming },
        answeredText: text.trim(),
        loading: false,
      });
    } catch (e) {
      if (token === queryToken) set({ loading: false });
      throw e;
    }
  },
  onReady: async (text, keepKey = "") => {
    const last = lastRequest;
    if (!last || last.text.trim().toLowerCase() !== text.trim().toLowerCase()) return;
    await get().run(last.text, last.filter, keepKey);
  },
  clearResults: () => {
    queryToken++;
    lastRequest = null;
    set({ page: null, loading: false, answeredText: "" });
  },
  toggleLabel: (label, display) =>
    set((s) => ({
      labels: s.labels.includes(label) ? s.labels.filter((l) => l !== label) : [...s.labels, label],
      labelNames: display ? { ...s.labelNames, [label]: display } : s.labelNames,
    })),
  addLabel: (label, display) =>
    set((s) => (s.labels.includes(label) ? s : { labels: [...s.labels, label], labelNames: display ? { ...s.labelNames, [label]: display } : s.labelNames })),
  clearLabels: () => set({ labels: [] }),
  setSimilar: (similar) => set({ similar }),

  loadThings: async () => {
    set({ thingsLoading: true });
    try {
      set({ things: (await SearchService.Things()) ?? [] });
    } finally {
      set({ thingsLoading: false });
    }
  },
  loadLabels: async (path) => {
    const hit = get().labelCache[path];
    if (hit) return hit;
    const labels = (await SearchService.Labels(path)) ?? [];
    set((s) => ({ labelCache: { ...s.labelCache, [path]: labels } }));
    return labels;
  },
  setLabel: async (path, label, on) => {
    await SearchService.SetLabel(path, label, on);
    set((s) => {
      const next = { ...s.labelCache };
      delete next[path];
      return { labelCache: next, indexedVersion: s.indexedVersion + 1 };
    });
  },
  loadTexts: async (path) => {
    const hit = get().textCache[path];
    if (hit) return hit;
    const texts = (await SearchService.Texts(path)) ?? [];
    set((s) => ({ textCache: { ...s.textCache, [path]: texts } }));
    return texts;
  },
  invalidate: (paths) =>
    set((s) => {
      const labelCache = { ...s.labelCache };
      const textCache = { ...s.textCache };
      for (const p of paths) {
        delete labelCache[p];
        delete textCache[p];
      }
      return { labelCache, textCache, indexedVersion: s.indexedVersion + 1 };
    }),

  setSelected: (selectedPath, selectedPos = -1) => set({ selectedPath, selectedPos }),
  requestFocus: () => set({ focusPending: true }),
  consumeFocus: () => {
    if (!get().focusPending) return false;
    set({ focusPending: false });
    return true;
  },
  warm: () => {
    const now = Date.now();
    if (now - lastWarm < WARM_MIN_MS) return;
    lastWarm = now;
    void Promise.resolve(SearchService.Warm()).catch(() => undefined);
  },
}));

/** Test hook: forget the module-level request memory. */
export function resetSearchMemory(): void {
  lastWarm = 0;
  queryToken = 0;
  lastRequest = null;
}

let syncUsers = 0;
let syncOff: (() => void) | null = null;

/** Subscribes to `search:status`, `search:indexed` and `search:ready` while any view that needs them is mounted. */
export function useSearchSync(onReady?: (text: string) => void): void {
  useEffect(() => {
    syncUsers++;
    if (syncUsers === 1) {
      const offs = [
        on("search:status", (s) => useSearch.getState().setStatus(s)),
        on("search:indexed", (p) => useSearch.getState().invalidate(p.paths ?? [])),
      ];
      syncOff = () => offs.forEach((f) => f());
      void useSearch.getState().loadStatus();
    }
    return () => {
      syncUsers--;
      if (syncUsers === 0) {
        syncOff?.();
        syncOff = null;
      }
    };
  }, []);
  useEffect(() => {
    if (!onReady) return;
    return on("search:ready", (r) => onReady(r.text));
  }, [onReady]);
}
