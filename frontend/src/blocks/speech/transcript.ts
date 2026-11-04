/** Transcript helpers shared by Transcribe and Subtitles (pure; no UI). */

export const FORMATS = ["txt", "srt", "vtt", "json"] as const;
export type TranscribeFormat = (typeof FORMATS)[number];

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

/** The file name of a path with either kind of separator. */
export function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

export const PREVIEW_LINES = 50;
export const PREVIEW_BYTES = 64 * 1024;
