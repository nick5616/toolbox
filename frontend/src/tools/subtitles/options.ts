import { SubtitlesAction, SubtitleStyle, type SubtitlesOptions, type SubtitlesResult } from "@/lib/api";

/** What the view remembers between sessions (never the cues). */
export interface Prefs {
  model: string;
  language: string;
  translateToEnglish: boolean;
  maxLineChars: number;
  maxLines: number;
  formats: string[];
  targetLanguage: string;
  style: SubtitleStyle;
  size: string;
  position: string;
  font: string;
  trackLanguage: string;
}

export const DEFAULT_PREFS: Prefs = {
  model: "small",
  language: "",
  translateToEnglish: false,
  maxLineChars: 42,
  maxLines: 2,
  formats: ["srt"],
  targetLanguage: "",
  style: SubtitleStyle.StyleClassic,
  size: "m",
  position: "bottom",
  font: "Arial",
  trackLanguage: "",
};

const MODELS = ["base", "small", "turbo"];
const STYLES: string[] = [SubtitleStyle.StyleClassic, SubtitleStyle.StyleBoxed, SubtitleStyle.StyleYellow, SubtitleStyle.StyleMinimal];

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

export function sanitizePrefs(saved: unknown, d: Prefs): Prefs {
  if (typeof saved !== "object" || saved === null) return d;
  const s = saved as Record<string, unknown>;
  const formats = Array.isArray(s.formats) ? s.formats.filter((f): f is string => f === "srt" || f === "vtt") : [];
  const lineChars = typeof s.maxLineChars === "number" ? Math.round(s.maxLineChars) : d.maxLineChars;
  return {
    model: MODELS.includes(str(s.model, "")) ? str(s.model, d.model) : d.model,
    language: str(s.language, d.language),
    translateToEnglish: typeof s.translateToEnglish === "boolean" ? s.translateToEnglish : d.translateToEnglish,
    maxLineChars: lineChars >= 32 && lineChars <= 60 ? lineChars : d.maxLineChars,
    maxLines: s.maxLines === 1 || s.maxLines === 2 ? s.maxLines : d.maxLines,
    formats: formats.length > 0 ? Array.from(new Set(formats)) : d.formats,
    targetLanguage: str(s.targetLanguage, d.targetLanguage),
    style: STYLES.includes(str(s.style, "")) ? (s.style as SubtitleStyle) : d.style,
    size: ["s", "m", "l"].includes(str(s.size, "")) ? str(s.size, d.size) : d.size,
    position: ["bottom", "top"].includes(str(s.position, "")) ? str(s.position, d.position) : d.position,
    font: str(s.font, d.font) || d.font,
    trackLanguage: str(s.trackLanguage, d.trackLanguage),
  };
}

/** Full Options for a job: the prefs plus the action fields. */
export function buildOptions(action: SubtitlesAction, prefs: Prefs, extra: Partial<SubtitlesOptions> = {}): SubtitlesOptions {
  return {
    action,
    model: prefs.model,
    language: prefs.language,
    translateToEnglish: prefs.translateToEnglish,
    maxLineChars: prefs.maxLineChars,
    maxLines: prefs.maxLines,
    streamIndex: 0,
    cues: [],
    formats: prefs.formats,
    sourceLanguage: "",
    targetLanguage: prefs.targetLanguage,
    style: prefs.style,
    size: prefs.size,
    position: prefs.position,
    font: prefs.font,
    trackLanguage: prefs.trackLanguage,
    ...extra,
  };
}

export function parseResult(json: string): SubtitlesResult | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as Partial<SubtitlesResult>;
    if (typeof r !== "object" || r === null) return null;
    return {
      action: r.action ?? SubtitlesAction.$zero,
      language: typeof r.language === "string" ? r.language : "",
      cues: typeof r.cues === "number" ? r.cues : 0,
      outputs: Array.isArray(r.outputs) ? r.outputs : [],
    };
  } catch {
    return null;
  }
}

export const MODEL_CHOICES = [
  { value: "base", label: "Base (fast)" },
  { value: "small", label: "Small (balanced)" },
  { value: "turbo", label: "Turbo (best)" },
];

export const SIZE_CHOICES = [
  { value: "s", label: "Small" },
  { value: "m", label: "Medium" },
  { value: "l", label: "Large" },
];

export const POSITION_CHOICES = [
  { value: "bottom", label: "Bottom" },
  { value: "top", label: "Top" },
];

/** Burn size → fraction of the shorter side. */
export const SIZE_FRACTION: Record<string, number> = { s: 0.045, m: 0.055, l: 0.065 };
