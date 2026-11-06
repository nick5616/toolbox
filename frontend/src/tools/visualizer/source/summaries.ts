/** One-line states for the Source step's click-ins. */
import type { AnalyzeOptions } from "@/lib/api";
import { basename, hasWords, SEED_LABEL, wordsChoiceOf, type SeedFrom } from "./logic";

export function wordsSummary(o: AnalyzeOptions, seedFrom: SeedFrom | null): string {
  switch (wordsChoiceOf(o.words)) {
    case "detect":
      return "Detect from the audio";
    case "align":
      return o.lyricsText.trim() ? "Pasted lyrics" : "Paste lyrics";
    case "file":
      return o.lyricsPath ? basename(o.lyricsPath) : "From a file";
    case "given":
      return seedFrom ? SEED_LABEL[seedFrom] : "Given lines";
    default:
      return "No words";
  }
}

export function instrumentsSummary(o: AnalyzeOptions): string {
  if (!o.stems) return "Off";
  return o.saveStems ? "Separated · saved" : "Separated";
}

/** The rail's one-liner for the Analysis panel: "Words · 4 stems · mood". */
export function analysisSummary(o: AnalyzeOptions): string {
  const words = hasWords(o);
  return [words ? "Words" : "No words", o.stems ? "4 stems" : "", words && o.mood ? "mood" : ""].filter(Boolean).join(" · ");
}

export function moodSummary(o: AnalyzeOptions): string {
  if (!hasWords(o)) return "Needs words";
  if (!o.mood) return "Off";
  return o.deepRead ? "Deeper reading" : "On";
}
