import {
  CaptionAction,
  CaptionField,
  CaptionLength,
  CaptionNamePattern,
  CaptionPreset,
  CaptionThen,
  CaptionTone,
  type CaptionBatch,
  type CaptionFields,
  type CaptionItem,
  type CaptionOptions,
} from "@/lib/api";

/** Mirrors modules/captions DefaultOptions(); the Go side's `Defaults()` is asked as well. */
export const DEFAULT_CAPTION_OPTIONS: CaptionOptions = {
  action: CaptionAction.ActionCaption,
  preset: CaptionPreset.PresetPosting,
  context: "",
  notes: {},
  tone: CaptionTone.ToneWarm,
  length: CaptionLength.LengthMedium,
  language: "",
  emoji: false,
  hashtags: 5,
  namePattern: CaptionNamePattern.NameOnly,
  kebab: false,
  useHints: true,
  readText: true,
  model: "",
  batch: "",
  index: -1,
  keepEdited: true,
  seed: 0,
  write: { alt: true, description: true, caption: true, captionFrom: CaptionField.FieldCaption, title: true, keywords: true, keepLocation: false },
  then: CaptionThen.ThenNothing,
};

export const MAX_FILES = 200;

export const PRESET_OPTIONS: ReadonlyArray<{ value: CaptionPreset; label: string; tip: string }> = [
  { value: CaptionPreset.PresetPosting, label: "For posting", tip: "A caption, hashtags and alt text for each file" },
  { value: CaptionPreset.PresetAccessible, label: "Accessible", tip: "Alt text and a longer description for each file" },
  { value: CaptionPreset.PresetCatalogue, label: "Catalogue", tip: "A title, a description and keywords for each file" },
  { value: CaptionPreset.PresetRename, label: "Rename", tip: "A new file name that says what is in each file" },
  { value: CaptionPreset.PresetEverything, label: "Everything", tip: "Every kind of text for each file" },
];

/** The preset's fields in display order, used until (or without) `CaptionService.Fields`. */
export const PRESET_FIELDS: Record<CaptionPreset, CaptionField[]> = {
  [CaptionPreset.$zero]: [CaptionField.FieldCaption, CaptionField.FieldHashtags, CaptionField.FieldAlt],
  [CaptionPreset.PresetPosting]: [CaptionField.FieldCaption, CaptionField.FieldHashtags, CaptionField.FieldAlt],
  [CaptionPreset.PresetAccessible]: [CaptionField.FieldAlt, CaptionField.FieldDescription],
  [CaptionPreset.PresetCatalogue]: [CaptionField.FieldTitle, CaptionField.FieldDescription, CaptionField.FieldKeywords],
  [CaptionPreset.PresetRename]: [CaptionField.FieldName],
  [CaptionPreset.PresetEverything]: [
    CaptionField.FieldTitle,
    CaptionField.FieldCaption,
    CaptionField.FieldHashtags,
    CaptionField.FieldAlt,
    CaptionField.FieldDescription,
    CaptionField.FieldKeywords,
    CaptionField.FieldName,
  ],
};

export const FIELD_LABEL: Record<string, string> = {
  alt: "Alt text",
  description: "Description",
  caption: "Caption",
  hashtags: "Hashtags",
  title: "Title",
  keywords: "Keywords",
  name: "File name",
};

export const FIELD_TIP: Record<string, string> = {
  alt: "What a screen reader says for this picture; 125 characters or fewer reads best",
  description: "A longer plain-text description",
  caption: "The text under the post; hashtags are kept separate",
  hashtags: "Tags to add under the caption",
  title: "A short title",
  keywords: "Search keywords for a catalogue or photo library",
  name: "A file name that says what is in the file (no extension)",
};

export const TONES: ReadonlyArray<{ value: CaptionTone; label: string }> = [
  { value: CaptionTone.TonePlain, label: "Plain" },
  { value: CaptionTone.ToneWarm, label: "Warm" },
  { value: CaptionTone.TonePlayful, label: "Playful" },
  { value: CaptionTone.ToneProfessional, label: "Professional" },
  { value: CaptionTone.TonePoetic, label: "Poetic" },
];

export const LENGTHS: ReadonlyArray<{ value: CaptionLength; label: string }> = [
  { value: CaptionLength.LengthShort, label: "Short" },
  { value: CaptionLength.LengthMedium, label: "Medium" },
  { value: CaptionLength.LengthLong, label: "Long" },
];

export const NAME_PATTERNS: ReadonlyArray<{ value: CaptionNamePattern; label: string }> = [
  { value: CaptionNamePattern.NameOnly, label: "Name" },
  { value: CaptionNamePattern.NameDate, label: "Date + name" },
  { value: CaptionNamePattern.NameNumber, label: "Number + name" },
];

/** "" = Auto (the app language). */
export const LANGUAGES: readonly string[] = [
  "Arabic", "Bengali", "Bulgarian", "Chinese", "Croatian", "Czech", "Danish", "Dutch", "English", "Finnish",
  "French", "German", "Greek", "Hebrew", "Hindi", "Hungarian", "Indonesian", "Italian", "Japanese", "Korean",
  "Norwegian", "Persian", "Polish", "Portuguese", "Romanian", "Russian", "Spanish", "Swedish", "Thai", "Turkish", "Ukrainian", "Vietnamese",
];

const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);

export function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i).toLowerCase();
}

export function isVideoPath(path: string): boolean {
  return VIDEO_EXT.has(extOf(path));
}

export const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

export function oneOf<T extends string>(v: unknown, all: readonly T[], fallback: T): T {
  return typeof v === "string" && (all as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Remembered options: only the user-facing settings are kept; run-specific fields always start fresh. */
export function sanitizeCaptionOptions(saved: unknown, defaults: CaptionOptions): CaptionOptions {
  if (typeof saved !== "object" || saved === null) return defaults;
  const r = saved as Record<string, unknown>;
  const h = typeof r.hashtags === "number" && Number.isFinite(r.hashtags) ? Math.min(15, Math.max(0, Math.round(r.hashtags))) : defaults.hashtags;
  return {
    ...defaults,
    preset: oneOf(r.preset, PRESET_OPTIONS.map((p) => p.value), defaults.preset),
    context: defaults.context,
    tone: oneOf(r.tone, TONES.map((t) => t.value), defaults.tone),
    length: oneOf(r.length, LENGTHS.map((t) => t.value), defaults.length),
    language: typeof r.language === "string" && (r.language === "" || LANGUAGES.includes(r.language)) ? r.language : defaults.language,
    emoji: typeof r.emoji === "boolean" ? r.emoji : defaults.emoji,
    hashtags: h,
    namePattern: oneOf(r.namePattern, NAME_PATTERNS.map((t) => t.value), defaults.namePattern),
    kebab: typeof r.kebab === "boolean" ? r.kebab : defaults.kebab,
    useHints: typeof r.useHints === "boolean" ? r.useHints : defaults.useHints,
    readText: typeof r.readText === "boolean" ? r.readText : defaults.readText,
    write: defaults.write,
  };
}

/** One line for the Advanced row: "Warm · medium · English · 5 hashtags". */
export function advancedSummary(o: CaptionOptions): string {
  const tone = TONES.find((t) => t.value === o.tone)?.label ?? o.tone;
  const parts = [tone, o.length, o.language === "" ? "Auto language" : o.language, o.hashtags === 0 ? "no hashtags" : `${o.hashtags} ${o.hashtags === 1 ? "hashtag" : "hashtags"}`];
  if (o.emoji) parts.push("emoji");
  return parts.join(" · ");
}

export const EMPTY_FIELDS: CaptionFields = { alt: "", description: "", caption: "", hashtags: [], title: "", keywords: [], name: "" };

export type FieldsView = Omit<CaptionFields, "hashtags" | "keywords"> & { hashtags: string[]; keywords: string[] };
export type ItemView = Omit<CaptionItem, "fields" | "edited"> & { fields: FieldsView; edited: Partial<Record<CaptionField, boolean>> };
export type BatchView = Omit<CaptionBatch, "items"> & { items: ItemView[] };

export function normItem(i: CaptionItem): ItemView {
  const f = i.fields ?? EMPTY_FIELDS;
  return { ...i, fields: { ...EMPTY_FIELDS, ...f, hashtags: f.hashtags ?? [], keywords: f.keywords ?? [] }, edited: i.edited ?? {} };
}

export function normBatch(b: CaptionBatch): BatchView {
  return { ...b, items: (b.items ?? []).map(normItem) };
}

export function pendingItem(input: string): ItemView {
  return normItem({ input, note: "", fields: EMPTY_FIELDS, edited: null, state: "pending", reason: "", seed: 0 });
}

export type ItemStatus = "pending" | "failed" | "done";
export function statusOf(i: { state: string }): ItemStatus {
  if (i.state === "failed") return "failed";
  if (i.state === "pending" || i.state === "running" || i.state === "queued") return "pending";
  return "done";
}

/** Characters as people count them (an emoji is one). */
export function countChars(s: string): number {
  return Array.from(s).length;
}
export const ALT_SOFT_LIMIT = 125;

/** "#Tag" from whatever the user typed; "" when nothing usable remains. */
export function toHashtag(raw: string): string {
  const w = raw.trim().replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
  return w === "" ? "" : `#${w}`;
}
export function toKeyword(raw: string): string {
  return raw.trim().toLowerCase();
}

/** What "Use" hands to a host tool: one JSON string in the embed's `paths` array (the contract carries strings only). */
export const USE_PREFIX = "captions:";
export interface UsePayload {
  input: string;
  caption: string;
  hashtags: string[];
  alt: string;
}
export function encodeUse(p: UsePayload): string {
  return USE_PREFIX + JSON.stringify(p);
}
