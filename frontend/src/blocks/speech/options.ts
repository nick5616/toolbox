/**
 * The transcription options both Transcribe and Subtitles show (Phase 11,
 * SPEC §5.3): which speech model, which spoken language, and whether the
 * words are written out translated into English. Pure helpers; the controls
 * are in `SpeechOptions.tsx`.
 */
import { TranscribeTask } from "@/lib/api";

/** What the user chooses before listening to a file. */
export interface SpeechSettings {
  /** "base" | "small" | "turbo". */
  model: string;
  /** ISO 639-1 code, "" = auto-detect. */
  language: string;
  /** Write the speech out in English whatever language is spoken. */
  translate: boolean;
}

export const SPEECH_MODELS = ["base", "small", "turbo"] as const;

export interface LanguageLike {
  code: string;
  name: string;
}

export interface ModelChoice {
  value: string;
  label: string;
  tip: string;
}

export const MODEL_CHOICES: ModelChoice[] = [
  { value: "base", label: "Base (fast)", tip: "Fastest and smallest; fine for clear speech" },
  { value: "small", label: "Small (balanced)", tip: "A good balance of speed and accuracy" },
  { value: "turbo", label: "Turbo (best)", tip: "Most accurate, especially for accents and noise; slowest" },
];

/** Whether `v` is one of the speech models. */
export function isSpeechModel(v: unknown): v is (typeof SPEECH_MODELS)[number] {
  return typeof v === "string" && (SPEECH_MODELS as readonly string[]).includes(v);
}

/** The spoken-language options: "Auto-detect" first, then the engine's list. */
export function languageOptions(languages: readonly LanguageLike[]): { value: string; label: string }[] {
  return [{ value: "", label: "Auto-detect" }, ...languages.map((l) => ({ value: l.code, label: l.name }))];
}

/** "English", or "Auto-detect" for no choice; falls back to the upper-cased code. */
export function languageName(code: string, languages: readonly LanguageLike[]): string {
  if (code === "") return "Auto-detect";
  return languages.find((l) => l.code === code)?.name ?? code.toUpperCase();
}

/** "Small": the short model name ("Base (fast)" → "Base"; an engine preset label is used as is). */
export function modelLabel(model: string, presets?: readonly { id: string; label: string }[]): string {
  const preset = presets?.find((p) => p.id === model);
  if (preset) return preset.label;
  const choice = MODEL_CHOICES.find((c) => c.value === model);
  if (choice) return choice.label.replace(/\s*\(.*\)$/, "");
  return model;
}

/** One line for a launcher: "Small · Auto-detect", plus " · to English" when translating. */
export function speechSummary(s: SpeechSettings, languages: readonly LanguageLike[], presets?: readonly { id: string; label: string }[]): string {
  return `${modelLabel(s.model, presets)} · ${languageName(s.language, languages)}${s.translate ? " · to English" : ""}`;
}

/** The Go option for a "translate to English" yes/no. */
export function taskOf(translate: boolean): TranscribeTask {
  return translate ? TranscribeTask.TaskTranslate : TranscribeTask.TaskTranscribe;
}

/** The yes/no for a Go task option. */
export function isTranslate(task: string): boolean {
  return task === TranscribeTask.TaskTranslate;
}
