import { StemsFormat, StemsPreset, type StemsOptions } from "@/lib/api";

export const MODULE_ID = "stems";

/** Output size hint (SPEC 7.7). No track duration is available in the view, so it is the per-minute line. */
export const STEMS_SIZE_HINT =
  "WAV ≈ 10 MB per minute per stem · FLAC is lossless and usually half that · MP3 ≈ 2.4 MB per minute";

/** Mirrors Go's DefaultOptions() (modules/stems). */
export const DEFAULT_STEMS_OPTIONS: StemsOptions = {
  preset: StemsPreset.PresetFourFast,
  format: StemsFormat.FormatFLAC,
};

function oneOf<T extends string>(enumObj: Record<string, T>, v: unknown): T | undefined {
  return typeof v === "string" && v !== "" && Object.values(enumObj).includes(v as T) ? (v as T) : undefined;
}

/** `sanitize` for useModuleOptions: keeps only valid fields over defaults. */
export function sanitizeStemsOptions(raw: unknown, defaults: StemsOptions): StemsOptions {
  const out: StemsOptions = { ...defaults };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  out.preset = oneOf(StemsPreset, r.preset) ?? out.preset;
  out.format = oneOf(StemsFormat, r.format) ?? out.format;
  return out;
}

export interface StemEntry {
  name: string;
  path: string;
}

export interface StemsResult {
  preset: string;
  model: string;
  stems: StemEntry[];
}

/** Parses a stems job's resultJson; null when missing or malformed. */
export function parseStemsResult(json: string | null | undefined): StemsResult | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== "object" || v === null) return null;
    const r = v as Record<string, unknown>;
    if (!Array.isArray(r.stems)) return null;
    const stems: StemEntry[] = [];
    for (const s of r.stems as unknown[]) {
      if (typeof s !== "object" || s === null) continue;
      const e = s as Record<string, unknown>;
      if (typeof e.name === "string" && typeof e.path === "string") stems.push({ name: e.name, path: e.path });
    }
    return {
      preset: typeof r.preset === "string" ? r.preset : "",
      model: typeof r.model === "string" ? r.model : "",
      stems,
    };
  } catch {
    return null;
  }
}

/** Parent directory of a path (either separator). */
export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : path;
}
