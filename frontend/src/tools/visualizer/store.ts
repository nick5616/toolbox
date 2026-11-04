/**
 * The Visualizer's state (SPEC.md §8, Phase 11 §5.5): one workspace, no steps.
 * What shows is derived: no input = the drop zone; an input without an
 * analysis = the analysis progress; an analysis = the designer.
 */
import { create } from "zustand";
import type { AnalysisRef, AnalyzeOptions, TimedLine } from "@/lib/api";
import type { Analysis } from "@/viz/analysis";
import type { Show } from "@/viz/types";
import type { ToolSeed } from "@/state/ui";
import { DEFAULT_EXPORT, type ExportPrefs } from "./exportPrefs";

export const VISUALIZER_ID = "visualizer";

/** What a `timed-text` handoff carries beyond the lines (SPEC.md §9.4, §9.5). */
export interface SeedLook {
  from: "lyric-video" | "subtitles";
  look: ToolSeed["look"] | null;
  overlay: boolean;
}

export interface VisualizerState {
  /** The song or video being worked on. */
  input: string | null;
  isVideo: boolean;
  /** "overlay" = visuals over the video; "full" = full-frame visuals. */
  mode: "full" | "overlay";
  /** The analysis options (Analysis panel). */
  analyze: AnalyzeOptions;
  /** Where handed-over timed text came from (SPEC.md §9.5). */
  seedFrom: "lyric-video" | "subtitles" | null;
  seedLines: TimedLine[] | null;
  /** The finished analysis (ref from Go, loaded files). */
  ref: AnalysisRef | null;
  analysis: Analysis | null;
  /** The design being edited. */
  show: Show | null;
  /** The Song Map selection used as the Export range. */
  selection: { startMs: number; endMs: number } | null;
  /** The render seed of this session: the same design renders the same frames. */
  renderSeed: number;
  /** The designer playhead, for "Render 10 s preview". */
  playheadMs: number;
  /** Width / height of the preview (the workspace sets it; the pop-out preview follows it). */
  aspect: number;
  /** Look details handed over with timed text; applied once by the workspace. */
  seedLook: SeedLook | null;
  /** Size, quality and sound of the render (Export panel); the view keeps them in module state. */
  exportPrefs: ExportPrefs;
  /** A panel something outside the workspace wants opened (palette commands); the view consumes it. */
  panelRequest: { id: string; n: number } | null;

  setInput(input: string | null, isVideo: boolean): void;
  setMode(mode: "full" | "overlay"): void;
  setAnalyze(patch: Partial<AnalyzeOptions>): void;
  setSeed(from: "lyric-video" | "subtitles" | null, lines: TimedLine[] | null): void;
  setAnalysis(ref: AnalysisRef | null, analysis: Analysis | null): void;
  setShow(show: Show | null): void;
  setSelection(selection: { startMs: number; endMs: number } | null): void;
  setRenderSeed(seed: number): void;
  setPlayheadMs(ms: number): void;
  setSeedLook(look: SeedLook | null): void;
  setAspect(aspect: number): void;
  setExportPrefs(patch: Partial<ExportPrefs>): void;
  requestPanel(id: string | null): void;
  reset(): void;
}

export const DEFAULT_ANALYZE: AnalyzeOptions = {
  stems: true,
  saveStems: false,
  words: "none" as AnalyzeOptions["words"],
  language: "",
  lyricsText: "",
  lyricsPath: "",
  lines: [],
  mood: true,
  deepRead: false,
};

const initial = {
  input: null,
  isVideo: false,
  mode: "full" as const,
  analyze: DEFAULT_ANALYZE,
  seedFrom: null,
  seedLines: null,
  ref: null,
  analysis: null,
  show: null,
  selection: null,
  renderSeed: 1,
  playheadMs: 0,
  aspect: 16 / 9,
  seedLook: null,
  exportPrefs: DEFAULT_EXPORT,
  panelRequest: null,
};

export const useVisualizer = create<VisualizerState>((set) => ({
  ...initial,
  setInput: (input, isVideo) => set({ input, isVideo, mode: isVideo ? "overlay" : "full", ref: null, analysis: null, selection: null, analyze: { ...DEFAULT_ANALYZE, stems: !isVideo } }),
  setMode: (mode) => set({ mode }),
  setAnalyze: (patch) => set((s) => ({ analyze: { ...s.analyze, ...patch } })),
  setSeed: (seedFrom, seedLines) => set({ seedFrom, seedLines }),
  setAnalysis: (ref, analysis) => set({ ref, analysis }),
  setShow: (show) => set({ show }),
  setSelection: (selection) => set({ selection }),
  setRenderSeed: (renderSeed) => set({ renderSeed }),
  setPlayheadMs: (playheadMs) => set({ playheadMs }),
  setSeedLook: (seedLook) => set({ seedLook }),
  setAspect: (aspect) => set({ aspect }),
  setExportPrefs: (patch) => set((s) => ({ exportPrefs: { ...s.exportPrefs, ...patch } })),
  requestPanel: (id) => set((s) => ({ panelRequest: id ? { id, n: (s.panelRequest?.n ?? 0) + 1 } : null })),
  reset: () => set(initial),
}));
