/**
 * Finds or makes the analysis of a file and loads it (SPEC.md §9.1, §9.4).
 * It checks VisualizerService.AnalysisFor first; when `auto` is set and none
 * matches, it submits a `visualizer` analyze job and follows it through the
 * jobs store. CONTRACT (foundation): VP1 implements it.
 */
import type { AnalysisRef, AnalyzeOptions } from "@/lib/api";
import type { AppErrorShape } from "@/lib/errors";
import type { Analysis } from "@/viz/analysis";

export interface VisualsAnalysisOptions {
  /** The analyze options (stems, words, mood…). */
  analyze: AnalyzeOptions;
  /** Submit the analysis by itself when no cached one matches. */
  auto: boolean;
}

export interface VisualsAnalysis {
  status: "idle" | "checking" | "running" | "ready" | "error";
  /** 0..1 while running. */
  progress: number;
  /** The engine stage text while running ("Separating instruments"…). */
  stage: string;
  ref: AnalysisRef | null;
  analysis: Analysis | null;
  error: AppErrorShape | null;
  /** Starts (or restarts) the analysis with the current options. */
  start(): void;
  /** Cancels a running analysis job. */
  cancel(): void;
}

export function useVisualsAnalysis(_path: string | null, _opts: VisualsAnalysisOptions): VisualsAnalysis {
  return { status: "idle", progress: 0, stage: "", ref: null, analysis: null, error: null, start() {}, cancel() {} };
}
