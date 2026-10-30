/** Export options (SPEC.md §8.4): types, sizes and the rules that depend on the mode. */

export const ASPECTS = ["16:9", "9:16", "1:1", "4:5"] as const;
export type Aspect = (typeof ASPECTS)[number];
export const HEIGHTS = [720, 1080, 1440, 2160] as const;
export type Height = (typeof HEIGHTS)[number];
export type Background = "none" | "cover" | "image" | "video";

export interface ExportPrefs {
  aspect: Aspect;
  /** Short side in pixels. */
  height: Height;
  fps: 30 | 60;
  audio: "original" | "instrumental";
  background: Background;
  backgroundPath: string;
}

export const DEFAULT_EXPORT: ExportPrefs = { aspect: "16:9", height: 1080, fps: 30, audio: "original", background: "none", backgroundPath: "" };

/** Width / height of an aspect. */
export function aspectValue(a: Aspect): number {
  switch (a) {
    case "16:9":
      return 16 / 9;
    case "9:16":
      return 9 / 16;
    case "4:5":
      return 4 / 5;
    default:
      return 1;
  }
}

/** The output size for an aspect with `height` as the short side (even numbers). */
export function outputSize(a: Aspect, height: number): { w: number; h: number } {
  const r = aspectValue(a);
  const even = (n: number) => Math.round(n / 2) * 2;
  return r >= 1 ? { w: even(height * r), h: height } : { w: height, h: even(height / r) };
}

export function sanitizeExport(raw: unknown): ExportPrefs {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const pick = <T,>(list: readonly T[], v: unknown, d: T): T => (list.includes(v as T) ? (v as T) : d);
  return {
    aspect: pick(ASPECTS, o.aspect, DEFAULT_EXPORT.aspect),
    height: pick(HEIGHTS, o.height, DEFAULT_EXPORT.height),
    fps: pick([30, 60] as const, o.fps, DEFAULT_EXPORT.fps),
    audio: pick(["original", "instrumental"] as const, o.audio, "original"),
    background: pick(["none", "cover", "image", "video"] as const, o.background, "none"),
    backgroundPath: typeof o.backgroundPath === "string" ? o.backgroundPath : "",
  };
}

/** What the export can offer for the current mode and analysis (the rules the UI shows). */
export function exportRules(mode: "full" | "overlay", hasStems: boolean, can2160: boolean) {
  return {
    showAspect: mode === "full",
    showFps: mode === "full",
    showBackground: mode === "full",
    heights: HEIGHTS.filter((h) => h !== 2160 || can2160),
    instrumentalAllowed: hasStems,
  };
}

/** Why Render can't start, or "". */
export function exportBlocker(p: ExportPrefs, mode: "full" | "overlay"): string {
  if (mode === "full" && (p.background === "image" || p.background === "video") && !p.backgroundPath) return `Choose the ${p.background} for the background.`;
  return "";
}
