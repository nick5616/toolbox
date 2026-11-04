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
  { value: "base", label: "Base (fast)", tip: "Fastest and smallest; fine for clear speech" },
  { value: "small", label: "Small (balanced)", tip: "A good balance of speed and accuracy" },
  { value: "turbo", label: "Turbo (best)", tip: "Most accurate, especially for accents and noise; slowest" },
];

export const CANVAS_CHOICES = [
  { value: "16:9", label: "16:9", tip: "Widescreen, for YouTube and TVs" },
  { value: "9:16", label: "9:16", tip: "Tall, for Reels, Shorts and TikTok" },
  { value: "1:1", label: "1:1", tip: "Square, for feed posts" },
];

export const QUALITY_CHOICES = [
  { value: "720", label: "720p", tip: "Smaller file and faster to render" },
  { value: "1080", label: "1080p", tip: "Full HD; sharper text, slower to render" },
];

export const BACKGROUND_CHOICES = [
  { value: "visualizer", label: "Visualizer", tip: "Animated visuals that react to the audio" },
  { value: "color", label: "Colour", tip: "A single plain colour behind the subtitles" },
  { value: "image", label: "Image", tip: "Your own picture behind the subtitles" },
];

/** State of the Source step's "Subtitle text" click-in: "42 characters · 2 lines · to English". */
export function splitSummary(p: Pick<Prefs, "maxLineChars" | "maxLines" | "translateToEnglish">): string {
  return `${p.maxLineChars} characters · ${p.maxLines} ${p.maxLines === 1 ? "line" : "lines"}${p.translateToEnglish ? " · to English" : ""}`;
}

/** State of the Export step's "Text" click-in: "Medium · bottom · Arial". */
export function textSummary(p: Pick<Prefs, "size" | "position" | "font">): string {
  const size = SIZE_CHOICES.find((c) => c.value === p.size)?.label ?? p.size;
  return `${size} · ${p.position} · ${p.font}`;
}

/** State of the "Video" click-in (audio only): "16:9 · 1080p · Visualizer". */
export function videoSummary(p: Pick<Prefs, "canvas" | "canvasHeight" | "background" | "backgroundPath">): string {
  const bg = BACKGROUND_CHOICES.find((c) => c.value === p.background)?.label ?? p.background;
  const need = p.background === "image" && !p.backgroundPath ? " (choose one)" : "";
  return `${p.canvas} · ${p.canvasHeight}p · ${bg}${need}`;
}

/** Canvas shape as width / height. */
export function canvasAspect(canvas: string): number {
  return canvas === "9:16" ? 9 / 16 : canvas === "1:1" ? 1 : 16 / 9;
}

export const SIZE_CHOICES = [
  { value: "s", label: "Small", tip: "Small text, about 4.5% of the picture height" },
  { value: "m", label: "Medium", tip: "Medium text, about 5.5% of the picture height" },
  { value: "l", label: "Large", tip: "Large text, about 6.5% of the picture height" },
];

export const POSITION_CHOICES = [
  { value: "bottom", label: "Bottom", tip: "Put the subtitles near the bottom, the usual place" },
  { value: "top", label: "Top", tip: "Put the subtitles near the top, out of the way of lower graphics" },
];

/** Burn size → fraction of the shorter side. */
export const SIZE_FRACTION: Record<string, number> = { s: 0.045, m: 0.055, l: 0.065 };
