import { normalizeHex } from "@/components";
import {
  LyricAction,
  LyricSource,
  type LyricLine,
  type LyricLook,
  type LyricVideoOptions,
  type LyricVideoResult,
} from "@/lib/api";

/** The look that is remembered (never the title/artist: those belong to a song). */
export type RememberedLook = Omit<LyricLook, "title" | "artist">;

/** What the view remembers between sessions (never the lyrics). */
export interface Prefs {
  look: RememberedLook;
  aspect: string;
  height: number;
  audio: string;
  source: LyricSource;
  language: string;
}

export const DEFAULT_LOOK: RememberedLook = {
  background: "blur-cover",
  backgroundPath: "",
  color1: "#1b1f2a",
  color2: "#3a2f5b",
  font: "Arial",
  textColor: "#ffffff",
  highlightColor: "#ffd166",
  karaoke: true,
  position: "center",
  showNext: true,
  visualizer: "none",
  titleCard: true,
};

export const DEFAULT_PREFS: Prefs = {
  look: DEFAULT_LOOK,
  aspect: "16:9",
  height: 1080,
  audio: "original",
  source: LyricSource.SourceAlign,
  language: "",
};

export const BACKGROUNDS = ["blur-cover", "cover", "color", "gradient", "image", "video"] as const;
export const ASPECTS = ["16:9", "9:16", "1:1"] as const;

function pick(v: unknown, allowed: readonly string[], fallback: string): string {
  return typeof v === "string" && allowed.includes(v) ? v : fallback;
}
function hex(v: unknown, fallback: string): string {
  return typeof v === "string" ? (normalizeHex(v) ?? fallback) : fallback;
}
function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

export function sanitizePrefs(saved: unknown, d: Prefs): Prefs {
  if (typeof saved !== "object" || saved === null) return d;
  const s = saved as Record<string, unknown>;
  const l = (typeof s.look === "object" && s.look !== null ? s.look : {}) as Record<string, unknown>;
  const dl = d.look;
  return {
    look: {
      background: pick(l.background, BACKGROUNDS, dl.background),
      backgroundPath: str(l.backgroundPath, dl.backgroundPath),
      color1: hex(l.color1, dl.color1),
      color2: hex(l.color2, dl.color2),
      font: str(l.font, dl.font) || dl.font,
      textColor: hex(l.textColor, dl.textColor),
      highlightColor: hex(l.highlightColor, dl.highlightColor),
      karaoke: bool(l.karaoke, dl.karaoke),
      position: pick(l.position, ["center", "lower"], dl.position),
      showNext: bool(l.showNext, dl.showNext),
      visualizer: pick(l.visualizer, ["none", "wave", "bars"], dl.visualizer),
      titleCard: bool(l.titleCard, dl.titleCard),
    },
    aspect: pick(s.aspect, ASPECTS, d.aspect),
    height: s.height === 720 || s.height === 1080 ? s.height : d.height,
    audio: pick(s.audio, ["original", "instrumental"], d.audio),
    source: pick(s.source, ["detect", "align", "file"], d.source) as LyricSource,
    language: str(s.language, d.language),
  };
}

export interface SongMeta {
  title: string;
  artist: string;
}

/** Full Options for a job: the prefs plus the action fields. */
export function buildOptions(
  action: LyricAction,
  prefs: Prefs,
  meta: SongMeta,
  extra: Partial<LyricVideoOptions> = {},
): LyricVideoOptions {
  return {
    action,
    source: prefs.source,
    language: prefs.language,
    text: "",
    lyricsPath: "",
    lines: [],
    look: { ...prefs.look, title: meta.title.trim(), artist: meta.artist.trim() },
    audio: prefs.audio,
    aspect: prefs.aspect,
    height: prefs.height,
    previewStartMs: 0,
    ...extra,
  };
}

export function parseResult(json: string): LyricVideoResult | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as Partial<LyricVideoResult>;
    if (typeof r !== "object" || r === null) return null;
    const lines: LyricLine[] = Array.isArray(r.lines)
      ? r.lines.map((l) => ({ ...l, words: Array.isArray(l.words) ? l.words : [] }))
      : [];
    return {
      action: r.action ?? LyricAction.$zero,
      lines,
      matched: typeof r.matched === "number" ? r.matched : 0,
      hasInstrumental: r.hasInstrumental === true,
      previewPath: typeof r.previewPath === "string" ? r.previewPath : "",
      outputs: Array.isArray(r.outputs) ? r.outputs : [],
    };
  } catch {
    return null;
  }
}

export const LYRIC_EXTS = [".lrc", ".srt", ".vtt", ".txt"];
export const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".bmp"];
export const VIDEO_EXTS = [".mp4", ".mov", ".mkv", ".webm", ".m4v"];

/** True when this run of the lyrics action needs the AI engine. */
export function lyricsNeedEngine(source: string, lyricsPath: string): boolean {
  return source !== "file" || /\.txt$/i.test(lyricsPath);
}
