/**
 * Pure logic for the Visualizer's Source and Analyze steps: the Words choices,
 * what the engine will need, whether Analyze can run, and the analyze stage
 * list derived from job progress messages (SPEC.md §8.1, §8.2).
 */
import { WordsSource, type AnalyzeOptions } from "@/lib/api";

export const VIDEO_EXTS = [".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"];
export const LYRIC_EXTS = [".lrc", ".srt", ".vtt", ".txt"];

export function isVideoPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && VIDEO_EXTS.includes(path.slice(dot).toLowerCase());
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

export type SeedFrom = "lyric-video" | "subtitles";

export const SEED_LABEL: Record<SeedFrom, string> = {
  "lyric-video": "From Lyric Video",
  subtitles: "From Subtitles",
};

/** The Words control values: the four choices plus the handed-over lines. */
export type WordsChoice = "detect" | "align" | "file" | "none" | "given";

export function wordsChoiceOf(w: AnalyzeOptions["words"]): WordsChoice {
  switch (w) {
    case WordsSource.WordsDetect:
      return "detect";
    case WordsSource.WordsAlign:
      return "align";
    case WordsSource.WordsFile:
      return "file";
    case WordsSource.WordsGiven:
      return "given";
    default:
      return "none";
  }
}

export function wordsSourceOf(c: WordsChoice): AnalyzeOptions["words"] {
  switch (c) {
    case "detect":
      return WordsSource.WordsDetect;
    case "align":
      return WordsSource.WordsAlign;
    case "file":
      return WordsSource.WordsFile;
    case "given":
      return WordsSource.WordsGiven;
    default:
      return WordsSource.WordsNone;
  }
}

export function hasWords(o: AnalyzeOptions): boolean {
  return wordsChoiceOf(o.words) !== "none";
}

/** Model components the chosen options need (pack component ids). */
export function neededModels(o: AnalyzeOptions): string[] {
  const out: string[] = [];
  if (o.stems) out.push("stems-default");
  const c = wordsChoiceOf(o.words);
  if (c === "detect" || c === "align") out.push("whisper-default");
  if (hasWords(o) && o.mood) out.push("mood-reader");
  return out;
}

/** Why Analyze can't run yet, or "" when it can. */
export function optionsIssue(input: string | null, o: AnalyzeOptions): string {
  if (!input) return "Choose a song or video first";
  const c = wordsChoiceOf(o.words);
  if (c === "align" && o.lyricsText.trim() === "") return "Paste the lyrics, or pick another Words option";
  if (c === "file" && o.lyricsPath === "") return "Choose a lyrics file, or pick another Words option";
  if (c === "given" && (o.lines ?? []).length === 0) return "There are no handed-over lines";
  return "";
}

/** The options as sent for analysis: unused fields are cleared so they don't change the cache key. */
export function cleanOptions(o: AnalyzeOptions): AnalyzeOptions {
  const c = wordsChoiceOf(o.words);
  const words = hasWords(o);
  return {
    ...o,
    saveStems: o.stems && o.saveStems,
    language: c === "detect" || c === "align" ? o.language : "",
    lyricsText: c === "align" ? o.lyricsText : "",
    lyricsPath: c === "file" ? o.lyricsPath : "",
    lines: c === "given" ? (o.lines ?? []) : [],
    mood: words && o.mood,
    deepRead: words && o.mood && o.deepRead,
  };
}

// ---- the analyze stage list ----

export type StageId = "stems" | "listen" | "words" | "mood";

export const STAGE_LABEL: Record<StageId, string> = {
  stems: "Separating instruments",
  listen: "Listening (beat, chords, sections)",
  words: "Finding the words",
  mood: "Reading the mood",
};

const STAGE_ORDER: StageId[] = ["stems", "listen", "words", "mood"];

/** Which stages the options will run. */
export function visibleStages(o: AnalyzeOptions): StageId[] {
  const words = hasWords(o);
  return STAGE_ORDER.filter((s) => (s === "stems" ? o.stems : s === "words" ? words : s === "mood" ? words && o.mood : true));
}

/** The stage a progress message belongs to, or null for messages that don't move the list. */
export function stageOfMessage(msg: string): StageId | null {
  const m = msg.toLowerCase();
  if (!m) return null;
  if (m.includes("mood") || m.includes("more deeply")) return "mood";
  if (m.includes("separating") || m.includes("instrumental") || m.includes("stem")) return "stems";
  if (m.includes("analysing") || m.includes("analyzing") || m.includes("listening")) return "listen";
  if (m.includes("words") || m.includes("emphasis") || m.includes("transcrib") || m.includes("align") || m.includes("lyrics")) return "words";
  return null;
}

export interface StageTracker {
  /** Stages that have reported progress in this run. */
  seen: StageId[];
  /** Furthest stage reached, or null. */
  furthest: StageId | null;
  /** The engine answered from the saved analysis. */
  savedAnalysis: boolean;
}

export const NEW_TRACKER: StageTracker = { seen: [], furthest: null, savedAnalysis: false };

export function trackMessage(t: StageTracker, msg: string): StageTracker {
  if (msg.toLowerCase().includes("saved analysis")) return t.savedAnalysis ? t : { ...t, savedAnalysis: true };
  const stage = stageOfMessage(msg);
  if (!stage) return t;
  const seen = t.seen.includes(stage) ? t.seen : [...t.seen, stage];
  const furthest = t.furthest === null || STAGE_ORDER.indexOf(stage) > STAGE_ORDER.indexOf(t.furthest) ? stage : t.furthest;
  return seen === t.seen && furthest === t.furthest ? t : { ...t, seen, furthest };
}

export type StageState = "pending" | "active" | "done" | "cached" | "failed" | "stopped";
export type RunPhase = "queued" | "running" | "done" | "failed" | "cancelled";

export interface StageRow {
  id: StageId;
  label: string;
  state: StageState;
}

/** The four-stage list for the current run. Stages that never reported are "from earlier". */
export function stageRows(o: AnalyzeOptions, t: StageTracker, phase: RunPhase): StageRow[] {
  const stages = visibleStages(o);
  const furthest = t.furthest && stages.includes(t.furthest) ? stages.indexOf(t.furthest) : -1;
  return stages.map((id, i) => {
    const earlier = t.savedAnalysis || !t.seen.includes(id);
    const finished: StageState = earlier ? "cached" : "done";
    let state: StageState;
    if (phase === "done") state = finished;
    else if (phase === "queued") state = "pending";
    else if (t.savedAnalysis) state = "cached";
    else if (i < furthest) state = finished;
    else if (i === Math.max(0, furthest)) state = phase === "running" ? "active" : phase === "failed" ? "failed" : "stopped";
    else state = "pending";
    if (phase === "failed" || phase === "cancelled") {
      if (i > Math.max(0, furthest)) state = "pending";
    }
    return { id, label: STAGE_LABEL[id], state };
  });
}

/** "English" for "en" (falls back to the code). */
export function languageName(code: string): string {
  if (!code) return "";
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
