import type { MetadataView } from "@/lib/api";

export const MODULE_ID = "exif";

export const FIELD_LABELS: Record<string, string> = {
  Title: "Title",
  Description: "Description",
  Artist: "Artist",
  Copyright: "Copyright",
  Keywords: "Keywords",
  DateTimeOriginal: "Date taken",
};

export const FIELD_HINTS: Record<string, string> = {
  Keywords: "Separate with commas.",
  DateTimeOriginal: "YYYY:MM:DD HH:MM:SS",
};

/** Fallback when EditableFields() isn't available (mirrors Go). */
export const DEFAULT_EDITABLE_FIELDS = ["Title", "Description", "Artist", "Copyright", "Keywords", "DateTimeOriginal"];

const DATE_RE = /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/;

/** Error message for a field value, or "" when valid. */
export function validateField(name: string, value: string): string {
  if (name === "DateTimeOriginal" && value !== "" && !DATE_RE.test(value)) {
    return "Use the format YYYY:MM:DD HH:MM:SS";
  }
  if (value.length > 2000) return "At most 2000 characters";
  return "";
}

/** Only the fields whose value differs from `initial`. */
export function changedFields(
  current: Readonly<Record<string, string>>,
  initial: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(current)) {
    if (v !== (initial[k] ?? "")) out[k] = v;
  }
  return out;
}

/** Current editable values of a file as a plain record (nullable map normalised). */
export function editableValues(view: MetadataView | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(view?.fields ?? {})) if (typeof v === "string") out[k] = v;
  return out;
}

const THUMB_EXT = /\.(jpe?g|png|webp|gif)$/i;
export const THUMB_MAX_BYTES = 20 * 1024 * 1024;

export function canThumbnail(path: string, sizeBytes: number): boolean {
  return THUMB_EXT.test(path) && sizeBytes <= THUMB_MAX_BYTES;
}

/** "48.8584, 2.2945" */
export function formatCoordinates(lat: number, lon: number): string {
  return `${Number(lat.toFixed(6))}, ${Number(lon.toFixed(6))}`;
}

export interface ExifJobResult {
  action: string;
  removedTags: number;
  output: string;
}

export function parseExifResult(json: string | null | undefined): ExifJobResult | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== "object" || v === null) return null;
    const r = v as Record<string, unknown>;
    if (typeof r.output !== "string" || r.output === "") return null;
    return {
      action: typeof r.action === "string" ? r.action : "",
      removedTags: typeof r.removedTags === "number" ? r.removedTags : 0,
      output: r.output,
    };
  } catch {
    return null;
  }
}

export function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}
