/**
 * Reopen where you left off (Phase 11 follow-up): the last source (input path,
 * kind, mode and analysis options) is kept in the Visualizer's module state as
 * `lastSource`. On open without a handoff it comes back if the file still
 * exists, and its cached analysis is looked up (`VisualizerService.AnalysisFor`,
 * never an analysis job). A missing file drops the record.
 */
import { VisualizerService, FilesService, type AnalyzeOptions } from "@/lib/api";
import { useUI } from "@/state/ui";
import { patchVizState, readVizState } from "./vizState";
import { loadRef } from "./source/analyzeRun";
import { DEFAULT_ANALYZE, useVisualizer, VISUALIZER_ID } from "./store";

export const LAST_SOURCE_KEY = "lastSource";
/** The record may not take more than this of the module's 64 KB. */
export const MAX_SOURCE_BYTES = 16 * 1024;

export interface LastSource {
  input: string;
  isVideo: boolean;
  mode: "full" | "overlay";
  analyze: AnalyzeOptions;
}

export function sanitizeAnalyze(raw: unknown): AnalyzeOptions {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_ANALYZE;
  const str = (v: unknown, f: string) => (typeof v === "string" ? v : f);
  const bool = (v: unknown, f: boolean) => (typeof v === "boolean" ? v : f);
  return {
    stems: bool(o.stems, d.stems),
    saveStems: bool(o.saveStems, d.saveStems),
    words: str(o.words, d.words) as AnalyzeOptions["words"],
    language: str(o.language, d.language),
    lyricsText: str(o.lyricsText, d.lyricsText),
    lyricsPath: str(o.lyricsPath, d.lyricsPath),
    lines: Array.isArray(o.lines) ? (o.lines as AnalyzeOptions["lines"]) : [],
    mood: bool(o.mood, d.mood),
    deepRead: bool(o.deepRead, d.deepRead),
  };
}

export function sanitizeLastSource(raw: unknown): LastSource | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.input !== "string" || !o.input) return null;
  return { input: o.input, isVideo: o.isVideo === true, mode: o.mode === "overlay" ? "overlay" : "full", analyze: sanitizeAnalyze(o.analyze) };
}

/** The record to keep for the store's source; too big (timed lines, lyrics) drops those and falls back to no words. */
export function buildLastSource(s: { input: string | null; isVideo: boolean; mode: "full" | "overlay"; analyze: AnalyzeOptions }): LastSource | null {
  if (!s.input) return null;
  const rec: LastSource = { input: s.input, isVideo: s.isVideo, mode: s.mode, analyze: s.analyze };
  if (JSON.stringify(rec).length <= MAX_SOURCE_BYTES) return rec;
  return { ...rec, analyze: { ...s.analyze, lines: [], lyricsText: "", words: DEFAULT_ANALYZE.words } };
}

let taken = false;
/** Restores once per page: React's StrictMode runs effects twice in dev. */
export function takeRestore(): boolean {
  if (taken) return false;
  taken = true;
  return true;
}
export function resetRestoreForTest(): void {
  taken = false;
}

function handoffPending(): boolean {
  return useUI.getState().handoff?.moduleId === VISUALIZER_ID;
}

/**
 * Brings the last source back unless something else is already open. Returns
 * true when the store was filled. Never submits a job.
 */
export async function restoreLastSource(isCancelled: () => boolean = () => false): Promise<boolean> {
  const rec = sanitizeLastSource((await readVizState())[LAST_SOURCE_KEY]);
  if (!rec) return false;
  const free = () => !isCancelled() && useVisualizer.getState().input === null && !handoffPending();
  if (!free()) return false;
  let exists = false;
  try {
    const info = (await FilesService.Stat([rec.input]))?.[0];
    exists = !!info && info.exists && !info.isDir;
  } catch {
    exists = false;
  }
  if (!free()) return false;
  if (!exists) {
    void patchVizState({ [LAST_SOURCE_KEY]: null });
    return false;
  }
  const s = useVisualizer.getState();
  s.setInput(rec.input, rec.isVideo);
  s.setMode(rec.mode);
  s.setAnalyze(rec.analyze);
  useVisualizer.setState({ restored: true });
  // The cache is looked up, not started.
  try {
    const [ref, ok] = await VisualizerService.AnalysisFor(rec.input, rec.analyze.stems);
    if (ok && !isCancelled() && useVisualizer.getState().input === rec.input) {
      const a = await loadRef(ref);
      const now = useVisualizer.getState();
      if (!isCancelled() && now.input === rec.input && !now.analysis) now.setAnalysis(ref, a);
    }
  } catch {
    /* no cache: the Analyze action waits */
  }
  return true;
}
