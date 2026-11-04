import { TranscribeModel, TranscribeTask, type TranscribeOptions } from "@/lib/api";
import { FORMATS } from "@/blocks/speech";

// The transcript helpers live in the speech block (Subtitles uses them too).
export {
  FORMATS,
  PREVIEW_BYTES,
  PREVIEW_LINES,
  basename,
  parseTranscriptResult,
  previewPath,
  toggleFormat,
  wasAutoDetected,
  type TranscribeFormat,
  type TranscriptResult,
} from "@/blocks/speech";

/** Mirrors Go's DefaultOptions() (modules/transcribe). */
export const DEFAULT_TRANSCRIBE_OPTIONS: TranscribeOptions = {
  model: TranscribeModel.ModelSmall,
  language: "",
  task: TranscribeTask.TaskTranscribe,
  formats: ["txt", "srt"],
  vad: true,
};

function oneOf<T extends string>(enumObj: Record<string, T>, v: unknown): T | undefined {
  return typeof v === "string" && v !== "" && Object.values(enumObj).includes(v as T) ? (v as T) : undefined;
}

/** `sanitize` for useModuleOptions: keeps only valid fields over defaults. */
export function sanitizeTranscribeOptions(raw: unknown, defaults: TranscribeOptions): TranscribeOptions {
  const out: TranscribeOptions = { ...defaults };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  out.model = oneOf(TranscribeModel, r.model) ?? out.model;
  out.task = oneOf(TranscribeTask, r.task) ?? out.task;
  if (typeof r.language === "string" && /^[a-z]{2,3}$/.test(r.language)) out.language = r.language;
  else if (r.language === "") out.language = "";
  if (Array.isArray(r.formats)) {
    const f = FORMATS.filter((x) => (r.formats as unknown[]).includes(x));
    if (f.length > 0) out.formats = [...f];
  }
  if (typeof r.vad === "boolean") out.vad = r.vad;
  return out;
}
