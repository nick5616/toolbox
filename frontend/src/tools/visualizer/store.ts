/**
 * The Visualizer view's state (SPEC.md §8). CONTRACT (foundation): UI-V2 owns
 * this file and may add fields; UI-V1 reads and writes the fields below.
 */
import { create } from "zustand";
import type { AnalysisRef, AnalyzeOptions, TimedLine } from "@/lib/api";
import type { Analysis } from "@/viz/analysis";
import type { Show } from "@/viz/types";
import type { ToolSeed } from "@/state/ui";

/** What a `timed-text` handoff carries beyond the lines (SPEC.md §9.4, §9.5). */
export interface SeedLook {
  from: "lyric-video" | "subtitles";
  look: ToolSeed["look"] | null;
  overlay: boolean;
}

export type VisualizerStep = "source" | "analyze" | "design" | "export";

export interface VisualizerState {
  step: VisualizerStep;
  /** The song or video being worked on. */
  input: string | null;
  isVideo: boolean;
  /** "overlay" = visuals over the video; "full" = full-frame visuals. */
  mode: "full" | "overlay";
  /** The analyze options chosen on the Source step. */
  analyze: AnalyzeOptions;
  /** Where handed-over timed text came from (SPEC.md §9.5). */
  seedFrom: "lyric-video" | "subtitles" | null;
  seedLines: TimedLine[] | null;
  /** The finished analysis (ref from Go, loaded files). */
  ref: AnalysisRef | null;
  analysis: Analysis | null;
  /** The design being edited (UI-V2). */
  show: Show | null;
  /** The Song Map selection used as the Export range (UI-V2). */
  selection: { startMs: number; endMs: number } | null;
  /** The render seed of this session: the same design renders the same frames (UI-V2). */
  renderSeed: number;
  /** The designer playhead, for "Render 10 s preview" (UI-V2). */
  playheadMs: number;
  /** Look details handed over with timed text; applied once by the Design step (UI-V2). */
  seedLook: SeedLook | null;

  setStep(step: VisualizerStep): void;
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
  step: "source" as VisualizerStep,
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
  seedLook: null,
};

export const useVisualizer = create<VisualizerState>((set) => ({
  ...initial,
  setStep: (step) => set({ step }),
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
  reset: () => set(initial),
}));
