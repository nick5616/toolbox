import { AudioFormat, AudioQuality, DownloadMode, MaxResolution, type DownloaderOptions } from "@/lib/api";

export const MODULE_ID = "downloader";

function oneOf<T extends string>(enumObj: Record<string, T>, v: unknown): T | undefined {
  return typeof v === "string" && v !== "" && Object.values(enumObj).includes(v as T) ? (v as T) : undefined;
}

/** Merges saved module state (JSON text) over defaults; unknown or invalid fields are ignored. */
export function mergeOptions(defaults: DownloaderOptions, savedJson: string | null | undefined): DownloaderOptions {
  const out: DownloaderOptions = { ...defaults };
  if (!savedJson) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(savedJson);
  } catch {
    return out;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  out.mode = oneOf(DownloadMode, r.mode) ?? out.mode;
  out.audioFormat = oneOf(AudioFormat, r.audioFormat) ?? out.audioFormat;
  out.audioQuality = oneOf(AudioQuality, r.audioQuality) ?? out.audioQuality;
  out.maxResolution = oneOf(MaxResolution, r.maxResolution) ?? out.maxResolution;
  if (typeof r.trimEnabled === "boolean") out.trimEnabled = r.trimEnabled;
  if (typeof r.trimStart === "string") out.trimStart = r.trimStart;
  if (typeof r.trimEnd === "string") out.trimEnd = r.trimEnd;
  if (typeof r.embedMetadata === "boolean") out.embedMetadata = r.embedMetadata;
  if (typeof r.embedThumbnail === "boolean") out.embedThumbnail = r.embedThumbnail;
  if (typeof r.playlist === "boolean") out.playlist = r.playlist;
  return out;
}

export function serializeOptions(o: DownloaderOptions): string {
  return JSON.stringify(o);
}
