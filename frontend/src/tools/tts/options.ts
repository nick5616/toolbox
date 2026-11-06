import { TtsFormat, TtsSplit, type TtsFileResult, type TtsOptions, type TtsResult, type TtsVoiceInfo } from "@/lib/api";

/** Mirrors Go's DefaultOptions() (modules/tts). */
export const DEFAULT_TTS_OPTIONS: TtsOptions = {
  voice: "af_heart",
  speed: 1,
  split: TtsSplit.SplitNone,
  format: TtsFormat.FormatMP3,
  preview: false,
};

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

/** The pack component that holds the Kokoro voices (the architect's catalog id). */
export const VOICE_MODEL_COMPONENT = "kokoro-voices";
export const ENGINE_DEP_ID = "audio-engine";

function oneOf<T extends string>(enumObj: Record<string, T>, v: unknown): T | undefined {
  return typeof v === "string" && v !== "" && Object.values(enumObj).includes(v as T) ? (v as T) : undefined;
}

/** `sanitize` for useModuleOptions: valid fields over the defaults; `preview` is never persisted. */
export function sanitizeTtsOptions(raw: unknown, defaults: TtsOptions): TtsOptions {
  const out: TtsOptions = { ...defaults, preview: false };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.voice === "string" && /^[a-z]{2}_[a-z]+$/.test(r.voice)) out.voice = r.voice;
  if (typeof r.speed === "number" && Number.isFinite(r.speed) && r.speed >= MIN_SPEED && r.speed <= MAX_SPEED) out.speed = r.speed;
  out.split = oneOf(TtsSplit, r.split) ?? out.split;
  out.format = oneOf(TtsFormat, r.format) ?? out.format;
  return out;
}

/** Parses a job's ResultJSON; null for anything unreadable. */
export function parseTtsResult(json: string): TtsResult | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== "object" || v === null) return null;
    const r = v as Record<string, unknown>;
    const files = Array.isArray(r.files)
      ? r.files.filter((f): f is TtsFileResult => typeof f === "object" && f !== null && typeof (f as TtsFileResult).path === "string")
      : [];
    return {
      files,
      seconds: typeof r.seconds === "number" ? r.seconds : 0,
      voice: typeof r.voice === "string" ? r.voice : "",
      previewPath: typeof r.previewPath === "string" ? r.previewPath : "",
    };
  } catch {
    return null;
  }
}

/** "3:05" or "1:02:03". */
export function formatSpeechLength(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function formatSpeed(v: number): string {
  return `${v.toFixed(2).replace(/0$/, "")}×`;
}

/** "Heart · American English, female" for the picker. */
export function voiceLabel(v: TtsVoiceInfo): string {
  return `${v.name} · ${v.group}, ${v.gender}`;
}

/** Voices in picker order: featured first, then the list's own order. */
export function orderVoices(list: readonly TtsVoiceInfo[]): TtsVoiceInfo[] {
  return [...list.filter((v) => v.featured), ...list.filter((v) => !v.featured)];
}

/** What a preview depends on; a new key means the old preview is stale. */
export function previewKey(o: Pick<TtsOptions, "voice" | "speed">): string {
  return `${o.voice}@${o.speed.toFixed(2)}`;
}

/** The Advanced summary's split wording. */
export function splitLabel(split: string): string {
  return split === TtsSplit.SplitHeadings ? "one file per heading" : "one file";
}
