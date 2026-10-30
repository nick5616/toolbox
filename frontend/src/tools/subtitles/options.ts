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
  /** Make a video from audio (SPEC.md 9.3). */
  canvas: string;
  canvasHeight: number;
  background: string;
  backgroundColor: string;
  backgroundPath: string;
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
  canvas: "16:9",
  canvasHeight: 1080,
  background: "visualizer",
  backgroundColor: "#11131a",
  backgroundPath: "",
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
    canvas: CANVAS_CHOICES.some((c) => c.value === s.canvas) ? str(s.canvas, d.canvas) : d.canvas,
    canvasHeight: s.canvasHeight === 720 || s.canvasHeight === 1080 ? s.canvasHeight : d.canvasHeight,
    background: BACKGROUND_CHOICES.some((c) => c.value === s.background) ? str(s.background, d.background) : d.background,
    backgroundColor: /^#[0-9a-fA-F]{6}$/.test(str(s.backgroundColor, "")) ? str(s.backgroundColor, d.backgroundColor) : d.backgroundColor,
    backgroundPath: str(s.backgroundPath, d.backgroundPath),
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
    canvas: prefs.canvas,
    canvasHeight: prefs.canvasHeight,
    background: prefs.background,
    backgroundColor: prefs.backgroundColor,
    backgroundPath: prefs.backgroundPath,
    visuals: null,
    ...extra,
  } as SubtitlesOptions;
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

export const CANVAS_CHOICES = [
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
  { value: "1:1", label: "1:1" },
];

export const QUALITY_CHOICES = [
  { value: "720", label: "720p" },
  { value: "1080", label: "1080p" },
];

export const BACKGROUND_CHOICES = [
  { value: "visualizer", label: "Visualizer" },
  { value: "color", label: "Colour" },
  { value: "image", label: "Image" },
];

/** Canvas shape as width / height. */
export function canvasAspect(canvas: string): number {
  return canvas === "9:16" ? 9 / 16 : canvas === "1:1" ? 1 : 16 / 9;
}

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
