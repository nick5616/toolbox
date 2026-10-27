import { MaxHeight, OutputKind, type ConverterOptions, type FileInfo, type PresetInfo } from "@/lib/api";

export const MODULE_ID = "converter";

/** Mirrors Go's DefaultOptions() (modules/converter). */
export const DEFAULT_CONVERTER_OPTIONS: ConverterOptions = {
  preset: "mp3-320",
  maxHeight: MaxHeight.HeightKeep,
  keepMetadata: true,
};

/** `sanitize` for useModuleOptions: keeps only valid fields over defaults. */
export function sanitizeConverterOptions(raw: unknown, defaults: ConverterOptions): ConverterOptions {
  const out: ConverterOptions = { ...defaults };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.preset === "string" && r.preset !== "") out.preset = r.preset;
  if (typeof r.maxHeight === "string" && r.maxHeight !== "" && (Object.values(MaxHeight) as string[]).includes(r.maxHeight)) {
    out.maxHeight = r.maxHeight as MaxHeight;
  }
  if (typeof r.keepMetadata === "boolean") out.keepMetadata = r.keepMetadata;
  return out;
}

function article(kind: string): string {
  return /^[aeiou]/i.test(kind) ? "an" : "a";
}

/** Inline error for inputs whose kind the preset can't take, keyed by path. */
export function incompatibleInputs(files: readonly FileInfo[], preset: PresetInfo | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!preset) return out;
  const accepts: readonly string[] = preset.acceptsKinds ?? [];
  if (accepts.length === 0) return out;
  for (const f of files) {
    const kind = f.kind || OutputKind.KindOther;
    if (!accepts.includes(kind)) out[f.path] = `${preset.label} can't take ${article(kind)} ${kind} file`;
  }
  return out;
}

/** Hint line under the preset select. */
export function presetHint(preset: PresetInfo | undefined): string {
  if (!preset) return "";
  const kinds = (preset.acceptsKinds ?? []).join(", ");
  return `Outputs ${preset.ext} · accepts ${kinds || "any file"}`;
}

/** Flat, group-prefixed options (the Select can't render optgroups). */
export function presetSelectOptions(presets: readonly PresetInfo[]): { value: string; label: string }[] {
  return presets.map((p) => ({ value: p.id, label: p.group ? `${p.group} · ${p.label}` : p.label }));
}
