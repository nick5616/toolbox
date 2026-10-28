import { TranscribeModel, TranscribeTask, type TranscribeOptions } from "@/lib/api";

export const FORMATS = ["txt", "srt", "vtt", "json"] as const;
export type TranscribeFormat = (typeof FORMATS)[number];

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

/** Toggles a format, keeping at least one selected and a stable order. */
export function toggleFormat(formats: readonly string[] | null, f: TranscribeFormat): string[] {
  const cur = new Set(formats ?? []);
  if (cur.has(f)) {
    if (cur.size <= 1) return FORMATS.filter((x) => cur.has(x));
    cur.delete(f);
  } else {
    cur.add(f);
  }
  return FORMATS.filter((x) => cur.has(x));
}

export interface TranscriptResult {
  language: string;
  languageProbability: number;
  durationSec: number;
  segments: number;
  outputs: string[];
}

/** Parses a transcribe job's resultJson; null when missing or malformed. */
export function parseTranscriptResult(json: string | null | undefined): TranscriptResult | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== "object" || v === null) return null;
    const r = v as Record<string, unknown>;
    const outputs = Array.isArray(r.outputs) ? (r.outputs as unknown[]).filter((o): o is string => typeof o === "string") : [];
    return {
      language: typeof r.language === "string" ? r.language : "",
      languageProbability: typeof r.languageProbability === "number" ? r.languageProbability : 0,
      durationSec: typeof r.durationSec === "number" ? r.durationSec : 0,
      segments: typeof r.segments === "number" ? r.segments : 0,
      outputs,
    };
  } catch {
    return null;
  }
}

/** Whether a job's options asked for auto-detected language. */
export function wasAutoDetected(optionsJson: string): boolean {
  try {
    const v: unknown = JSON.parse(optionsJson);
    return typeof v === "object" && v !== null && (v as Record<string, unknown>).language === "";
  } catch {
    return false;
  }
}

/** The output to preview: the TXT, else SRT, else VTT. */
export function previewPath(outputs: readonly string[]): string | undefined {
  for (const ext of [".txt", ".srt", ".vtt"]) {
    const p = outputs.find((o) => o.toLowerCase().endsWith(ext));
    if (p) return p;
  }
  return undefined;
}

export function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

export const PREVIEW_LINES = 50;
export const PREVIEW_BYTES = 64 * 1024;
