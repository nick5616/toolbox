/**
 * Edit Studio state (Phase 9 SPEC §14.12; Wave 0, frozen API). Packages read
 * it through the hooks at the bottom (stable references) and change the
 * document only with `edit(next, key)`.
 */
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { MediaService, type AnalysisRef, type EditMatteState, type EditSourceState, type EditStream } from "@/lib/api";
import { adoptParkedHistory, registerHistory } from "@/lib/parkedHistory";
import { newHistory, pushHistory, redo as redoH, undo as undoH, type History } from "@/lib/history";
import type { Analysis } from "@/viz/analysis";
import { normalizeProject, type NormalProject } from "@/viz/edit/defaults";
import { emptyAnalysis } from "@/viz/edit/emptyAnalysis";
import { deriveMarkers } from "@/viz/edit/markers";
import type { EditFiles, EditInputs, Marker, MarkerLane } from "@/viz/edit/types";

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export type Selection =
  | { kind: "clips"; ids: string[] }
  | { kind: "track"; id: string }
  | { kind: "song" }
  | { kind: "markers"; ids: string[] }
  | { kind: "range"; fromMs: number; toMs: number }
  | null;

export type AnalysisState = "none" | "loading" | "ready" | "missing" | "error";

export interface EditJobs {
  analyze?: string;
  prepare?: string;
  render?: string;
  /** matte ID → job ID */
  mattes: Record<string, string>;
  /** interp key ("<path>|<fromS>-<toS>") → job ID */
  interps: Record<string, string>;
}

export interface EditStudioState {
  projectId: string | null;
  name: string;
  history: History<NormalProject> | null;
  saveState: SaveState;
  saveError: string | null;

  selection: Selection;
  playheadMs: number; // timeline ms
  playing: boolean;
  /** Preview quality (Phase 21 §B1): "draft" renders the preview smaller and faster; the canvas honours it. */
  previewQuality: "draft" | "full";
  /** A short grain of sound while scrubbing or stepping (Phase 21 §B1). */
  scrubAudio: boolean;
  activeLane: MarkerLane;
  snap: boolean;
  pps: number; // pixels per second, 6..2000
  scrollMs: number; // left edge of the timeline view
  rightPanel: "inspector" | "captions";
  safeZones: boolean;
  /** Setup (analysis + range) is shown instead of the timeline. New edits without clips start there. */
  setupOpen: boolean;
  /** Setup shows the analysis panel even though an analysis is loaded ("Analyze again…"). */
  reanalyze: boolean;
  /** The open dialog (any package may ask; the view shows it). */
  dialog: { kind: "autofill"; range: { fromMs: number; toMs: number } | null } | { kind: "export" } | null;

  analysisRef: AnalysisRef | null;
  analysis: Analysis | null;
  analysisState: AnalysisState;
  sources: Record<string, EditSourceState>; // by path
  mattes: Record<string, EditMatteState>; // by matte ID
  interps: Record<string, EditStream>; // by interp key, preview tier
  urls: Record<string, string>; // file path → /media URL
  jobs: EditJobs;

  open(id: string, name: string, doc: NormalProject): void;
  close(): void;
  setName(name: string): void;
  /** Records a new document; same non-empty key within 800 ms = one undo step. */
  edit(next: NormalProject, key?: string): void;
  undo(): void;
  redo(): void;
  select(s: Selection): void;
  setPlayhead(ms: number): void;
  setPlaying(p: boolean): void;
  setPreviewQuality(q: "draft" | "full"): void;
  setScrubAudio(on: boolean): void;
  setActiveLane(l: MarkerLane): void;
  setSnap(on: boolean): void;
  setView(pps: number, scrollMs: number): void;
  setRightPanel(p: "inspector" | "captions"): void;
  setSafeZones(on: boolean): void;
  openDialog(d: EditStudioState["dialog"]): void;
  setSetupOpen(open: boolean): void;
  /** Opens Setup on the analysis panel to analyze the song again (or closes that). */
  setReanalyze(on: boolean): void;
  setSaveState(s: SaveState, error?: string | null): void;
  setAnalysis(ref: AnalysisRef | null, a: Analysis | null, state: AnalysisState): void;
  setSources(states: EditSourceState[]): void;
  setMattes(states: EditMatteState[]): void;
  setInterp(key: string, s: EditStream | null): void;
  addUrls(urls: Record<string, string>): void;
  setJob(kind: "analyze" | "prepare" | "render", id: string | undefined): void;
  setMatteJob(matteId: string, jobId: string | undefined): void;
  setInterpJob(key: string, jobId: string | undefined): void;
}

const initial = {
  projectId: null,
  name: "",
  history: null,
  saveState: "idle" as SaveState,
  saveError: null,
  selection: null,
  playheadMs: 0,
  playing: false,
  previewQuality: "full" as "draft" | "full",
  scrubAudio: true,
  activeLane: "downbeat" as MarkerLane,
  snap: true,
  pps: 80,
  scrollMs: 0,
  rightPanel: "inspector" as const,
  safeZones: false,
  setupOpen: false,
  reanalyze: false,
  dialog: null,
  analysisRef: null,
  analysis: null,
  analysisState: "none" as AnalysisState,
  sources: {},
  mattes: {},
  interps: {},
  urls: {},
  jobs: { mattes: {}, interps: {} },
};

const without = <T>(r: Record<string, T>, k: string): Record<string, T> => {
  if (!(k in r)) return r;
  const out = { ...r };
  delete out[k];
  return out;
};

export const useEditStudio = create<EditStudioState>((set, get) => ({
  ...initial,

  open: (id, name, doc) => {
    set({ ...initial, urls: get().urls, scrubAudio: get().scrubAudio, projectId: id, name, history: newHistory(normalizeProject(doc)), saveState: "saved", setupOpen: normalizeProject(doc).tracks.every((t) => t.clips.length === 0) });
    void adoptParkedHistory("editor", id);
  },
  close: () => set({ ...initial, urls: get().urls, scrubAudio: get().scrubAudio }),
  setName: (name) => set({ name }),
  edit: (next, key = "") => {
    const h = get().history;
    if (!h) return;
    const n = normalizeProject(next);
    const nh = pushHistory(h, n, key);
    if (nh !== h) set({ history: nh, saveState: "dirty" });
  },
  undo: () => {
    const h = get().history;
    if (h && h.past.length) set({ history: undoH(h), saveState: "dirty" });
  },
  redo: () => {
    const h = get().history;
    if (h && h.future.length) set({ history: redoH(h), saveState: "dirty" });
  },
  select: (selection) => set({ selection }),
  setPlayhead: (ms) => set({ playheadMs: Math.max(0, ms) }),
  setPlaying: (playing) => set({ playing }),
  setPreviewQuality: (previewQuality) => set({ previewQuality }),
  setScrubAudio: (scrubAudio) => set({ scrubAudio }),
  setActiveLane: (activeLane) => set({ activeLane }),
  setSnap: (snap) => set({ snap }),
  setView: (pps, scrollMs) => set({ pps: Math.max(6, Math.min(2000, pps)), scrollMs: Math.max(0, scrollMs) }),
  setRightPanel: (rightPanel) => set({ rightPanel }),
  setSafeZones: (safeZones) => set({ safeZones }),
  openDialog: (dialog) => set({ dialog }),
  setSetupOpen: (setupOpen) => set(setupOpen ? { setupOpen } : { setupOpen, reanalyze: false }),
  setReanalyze: (reanalyze) => set(reanalyze ? { reanalyze, setupOpen: true } : { reanalyze }),
  setSaveState: (saveState, saveError = null) => set({ saveState, saveError }),
  setAnalysis: (analysisRef, analysis, analysisState) => set({ analysisRef, analysis, analysisState }),
  setSources: (states) => {
    if (!states.length) return;
    const sources = { ...get().sources };
    for (const s of states) sources[s.path] = s;
    set({ sources });
  },
  setMattes: (states) => {
    if (!states.length) return;
    const mattes = { ...get().mattes };
    for (const s of states) mattes[s.id] = s;
    set({ mattes });
  },
  setInterp: (key, s) => set({ interps: s ? { ...get().interps, [key]: s } : without(get().interps, key) }),
  addUrls: (urls) => {
    const cur = get().urls;
    if (Object.entries(urls).every(([k, v]) => cur[k] === v)) return;
    set({ urls: { ...cur, ...urls } });
  },
  setJob: (kind, id) => set({ jobs: { ...get().jobs, [kind]: id } }),
  setMatteJob: (matteId, jobId) => {
    const j = get().jobs;
    set({ jobs: { ...j, mattes: jobId ? { ...j.mattes, [matteId]: jobId } : without(j.mattes, matteId) } });
  },
  setInterpJob: (key, jobId) => {
    const j = get().jobs;
    set({ jobs: { ...j, interps: jobId ? { ...j.interps, [key]: jobId } : without(j.interps, key) } });
  },
}));

// Undo history survives popping the whole tool out and bringing it back (lib/parkedHistory.ts).
registerHistory("editor", ["video-studio", "edit-studio"], {
  docId: () => useEditStudio.getState().projectId,
  read: () => {
    const h = useEditStudio.getState().history;
    return h ? { past: h.past, future: h.future } : null;
  },
  write: ({ past, future }) => {
    const h = useEditStudio.getState().history;
    if (h) useEditStudio.setState({ history: { ...h, past: past as NormalProject[], future: future as NormalProject[] } });
  },
  subscribe: (cb) =>
    useEditStudio.subscribe((s, prev) => {
      if (s.history !== prev.history) cb();
    }),
});

// Dev builds only: a handle for automated UI checks (.dev QA scripts drive the editor over DevTools).
if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as { __editStudio?: typeof useEditStudio }).__editStudio = useEditStudio;

// ---- hooks ----

/** The current document (null when no edit is open). */
export function useProject(): NormalProject | null {
  return useEditStudio((s) => s.history?.present ?? null);
}

/** Every lane's markers for the project's range (memoised on analysis, marker state and range). */
export function useMarkers(): Marker[] {
  const analysis = useEditStudio((s) => s.analysis);
  const markers = useEditStudio((s) => s.history?.present.markers ?? null);
  const start = useEditStudio((s) => s.history?.present.song?.startMs ?? 0);
  const end = useEditStudio((s) => s.history?.present.song?.endMs ?? 0);
  return useMemo(() => (analysis && markers && end > start ? deriveMarkers(analysis, markers, { startMs: start, endMs: end }) : EMPTY_MARKERS), [analysis, markers, start, end]);
}
const EMPTY_MARKERS: Marker[] = [];

/** The selected clips' IDs (empty when the selection isn't clips). */
export function useSelectedClipIds(): readonly string[] {
  return useEditStudio((s) => (s.selection?.kind === "clips" ? s.selection.ids : NO_IDS));
}
const NO_IDS: readonly string[] = [];

/** Interp key of a source range (§7.5): whole seconds. */
export function interpKey(path: string, fromMs: number, toMs: number): string {
  return `${path}|${Math.floor(fromMs / 1000)}-${Math.ceil(toMs / 1000)}`;
}

/** Files the preview needs, with their /media URLs when known. */
function filesFor(p: NormalProject, s: Pick<EditStudioState, "sources" | "mattes" | "interps" | "urls">): { files: EditFiles; missing: string[] } {
  const files: EditFiles = { streams: {}, images: {} };
  const missing: string[] = [];
  const url = (path: string) => {
    const u = s.urls[path];
    if (!u) missing.push(path);
    return u;
  };
  const stream = (st: EditStream) => {
    const a = url(st.stream);
    const b = url(st.index);
    return a && b ? { url: a, indexUrl: b } : null;
  };
  for (const t of p.tracks) {
    for (const c of t.clips) {
      const src = c.path ? s.sources[c.path] : undefined;
      if (c.kind === "video" && src?.preview) {
        const r = stream(src.preview);
        if (r) files.streams[`v:${c.path}`] = r;
      }
      if (c.kind === "image" && src?.image) {
        const u = url(src.image);
        if (u) files.images[`p:${c.path}`] = u;
      }
      const mt = c.matte?.id ? s.mattes[c.matte.id] : undefined;
      if (mt?.ready) {
        if (mt.preview) {
          const r = stream(mt.preview);
          if (r && c.matte) files.streams[`m:${c.matte.id}`] = r;
        } else if (mt.image && c.matte) {
          const u = url(mt.image);
          if (u) files.images[`m:${c.matte.id}`] = u;
        }
      }
    }
  }
  for (const [key, st] of Object.entries(s.interps)) {
    const r = stream(st);
    if (r) files.streams[`i:${key}`] = r;
  }
  return { files, missing };
}

/**
 * The preview's EditInputs (null until a project is open; without an analysis,
 * the empty one and no markers: a song without analysis is just audio).
 * Fetches missing /media URLs in the background.
 */
export function useEditInputs(): EditInputs | null {
  const project = useProject();
  const analysis = useEditStudio((s) => s.analysis);
  const sources = useEditStudio((s) => s.sources);
  const mattes = useEditStudio((s) => s.mattes);
  const interps = useEditStudio((s) => s.interps);
  const urls = useEditStudio((s) => s.urls);
  const markers = useMarkers();
  const built = useMemo(() => (project ? filesFor(project, { sources, mattes, interps, urls }) : null), [project, sources, mattes, interps, urls]);
  const missingKey = built?.missing.join("\n") ?? "";
  useEffect(() => {
    if (!missingKey) return;
    let live = true;
    const paths = missingKey.split("\n");
    void Promise.all(paths.map((p) => MediaService.URLFor(p).then((u) => [p, u] as const, () => null))).then((pairs) => {
      if (!live) return;
      const add: Record<string, string> = {};
      for (const pr of pairs) if (pr) add[pr[0]] = pr[1];
      useEditStudio.getState().addUrls(add);
    });
    return () => {
      live = false;
    };
  }, [missingKey]);
  return useMemo(() => (project && built ? { project, analysis: analysis ?? emptyAnalysis(), markers: analysis ? markers : EMPTY_MARKERS, files: built.files } : null), [project, analysis, markers, built]);
}

// Dev builds only: a handle for automated UI checks (.dev QA scripts), like window.__ui.
if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as { __edit?: typeof useEditStudio }).__edit = useEditStudio;
