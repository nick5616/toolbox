import { CleanupDenoise, CleanupFormat, CleanupHum, CleanupLoudness, type AudioCleanupOptions } from "@/lib/api";
import { extOf } from "@/tools/_kit/accepts";

/** Mirrors Go's DefaultOptions() (modules/audiocleanup). */
export const DEFAULT_CLEANUP_OPTIONS: AudioCleanupOptions = {
  highPass: true,
  hum: CleanupHum.HumAuto,
  denoise: CleanupDenoise.DenoiseVoice,
  loudness: CleanupLoudness.LoudnessPodcast,
  format: CleanupFormat.FormatSame,
  preview: false,
  previewStartMs: 0,
};

/** Length of an A/B excerpt (Go: previewSeconds). */
export const PREVIEW_MS = 10_000;

/** The AI engine dependency id and the pack component that holds the DeepFilterNet3 model. */
export const ENGINE_DEP_ID = "audio-engine";
export const VOICE_MODEL_COMPONENT = "voice-denoise";

function oneOf<T extends string>(enumObj: Record<string, T>, v: unknown): T | undefined {
  return typeof v === "string" && v !== "" && Object.values(enumObj).includes(v as T) ? (v as T) : undefined;
}

/** `sanitize` for useModuleOptions: keeps only valid fields over defaults. Preview fields are never persisted. */
export function sanitizeCleanupOptions(raw: unknown, defaults: AudioCleanupOptions): AudioCleanupOptions {
  const out: AudioCleanupOptions = { ...defaults, preview: false, previewStartMs: 0 };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.highPass === "boolean") out.highPass = r.highPass;
  out.hum = oneOf(CleanupHum, r.hum) ?? out.hum;
  out.denoise = oneOf(CleanupDenoise, r.denoise) ?? out.denoise;
  out.loudness = oneOf(CleanupLoudness, r.loudness) ?? out.loudness;
  out.format = oneOf(CleanupFormat, r.format) ?? out.format;
  return out;
}

const VIDEO_EXTS = new Set(["mp4", "m4v", "mov", "mkv", "webm", "avi", "ts", "mts", "m2ts", "wmv", "flv", "3gp"]);

export function isVideoPath(path: string): boolean {
  return VIDEO_EXTS.has(extOf(path));
}

/** The options that change what the cleaned audio sounds like (the format doesn't). */
export function previewKey(o: AudioCleanupOptions, path: string, startMs: number): string {
  return JSON.stringify([path, startMs, o.highPass, o.hum, o.denoise, o.loudness]);
}

export interface LoudnessInfo {
  label: string;
  /** "-16 LUFS · -1.5 dBTP" */
  detail: string;
}

export const LOUDNESS_INFO: Record<string, LoudnessInfo> = {
  [CleanupLoudness.LoudnessOff]: { label: "Off", detail: "Loudness is left as it is" },
  [CleanupLoudness.LoudnessPodcast]: { label: "Podcast", detail: "−16 LUFS · −1.5 dBTP" },
  [CleanupLoudness.LoudnessStreaming]: { label: "Streaming", detail: "−14 LUFS · −1 dBTP" },
  [CleanupLoudness.LoudnessBroadcast]: { label: "Broadcast", detail: "−23 LUFS · −1 dBTP" },
};

export const DENOISE_HINT: Record<string, string> = {
  [CleanupDenoise.DenoiseOff]: "Leave the background noise as it is",
  [CleanupDenoise.DenoiseLight]: "Gentle FFT denoise",
  [CleanupDenoise.DenoiseStrong]: "RNNoise: stronger, built into the app",
  [CleanupDenoise.DenoiseVoice]: "DeepFilterNet: best for speech. Needs the AI engine",
};

export interface FileOutcome {
  input: string;
  output: string;
  lufsBefore: number;
  lufsAfter: number;
  humHz: number;
}

export interface PreviewOutcome {
  previewOriginal: string;
  previewCleaned: string;
  lufsBefore: number;
  lufsAfter: number;
  humHz: number;
}

function obj(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const s = (v: unknown): string => (typeof v === "string" ? v : "");

/** Per-file results of a finished cleanup job (empty for preview jobs and bad JSON). */
export function parseFiles(json: string | null | undefined): FileOutcome[] {
  const r = obj(json);
  const files = r?.files;
  if (!Array.isArray(files)) return [];
  const out: FileOutcome[] = [];
  for (const f of files) {
    if (typeof f !== "object" || f === null) continue;
    const o = f as Record<string, unknown>;
    if (!s(o.output)) continue;
    out.push({ input: s(o.input), output: s(o.output), lufsBefore: n(o.lufsBefore), lufsAfter: n(o.lufsAfter), humHz: n(o.humHz) });
  }
  return out;
}

/** The excerpt paths and measurements of a finished preview job; null otherwise. */
export function parsePreview(json: string | null | undefined): PreviewOutcome | null {
  const r = obj(json);
  if (!r || !s(r.previewOriginal) || !s(r.previewCleaned)) return null;
  return {
    previewOriginal: s(r.previewOriginal),
    previewCleaned: s(r.previewCleaned),
    lufsBefore: n(r.lufsBefore),
    lufsAfter: n(r.lufsAfter),
    humHz: n(r.humHz),
  };
}

/** "−27.4" with a real minus sign. */
export function formatLufs(v: number): string {
  return v.toFixed(1).replace("-", "−");
}

/** "−27.4 LUFS → −16.0 LUFS · hum 50 Hz removed" */
export function previewSummary(p: PreviewOutcome): string {
  const base = `${formatLufs(p.lufsBefore)} LUFS → ${formatLufs(p.lufsAfter)} LUFS`;
  return p.humHz > 0 ? `${base} · hum ${p.humHz} Hz removed` : base;
}

/** Start of the excerpt for a click at `fraction` of the file, kept inside the file. */
export function previewStartFor(fraction: number, durationMs: number): number {
  if (durationMs <= PREVIEW_MS) return 0;
  const raw = Math.round(Math.min(Math.max(fraction, 0), 1) * durationMs);
  return Math.min(raw, durationMs - PREVIEW_MS);
}
