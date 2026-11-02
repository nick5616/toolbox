// Quick vlog request building (SPEC.md Part B §B6.3).
import type { VlogPlanRequest } from "@/lib/api";

export const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".opus", ".wma"];

export interface VlogForm {
  paths: string[];
  musicPath: string;
  aspect: string;
  order: "as-given" | "date-taken";
  /** "music": fit to the song (or about 3 s a clip without one); "seconds": a set length. */
  length: "music" | "seconds";
  seconds: number;
  beatCut: boolean;
  transition: "cut" | "fade" | "dip" | "slide";
}

export const DEFAULT_VLOG: VlogForm = {
  paths: [],
  musicPath: "",
  aspect: "9:16",
  order: "date-taken",
  length: "music",
  seconds: 30,
  beatCut: false,
  transition: "fade",
};

export function isAudioPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && AUDIO_EXTENSIONS.includes(path.slice(dot).toLowerCase());
}

/** Splits dropped paths into clips/photos and (the first) song; keeps existing entries and drops duplicates. */
export function addVlogPaths(form: VlogForm, paths: readonly string[]): VlogForm {
  const have = new Set(form.paths);
  const next = [...form.paths];
  let musicPath = form.musicPath;
  for (const p of paths) {
    if (isAudioPath(p)) {
      if (!musicPath) musicPath = p;
    } else if (!have.has(p) && next.length < 200) {
      have.add(p);
      next.push(p);
    }
  }
  return { ...form, paths: next, musicPath };
}

/** The PlanRequest for a form. */
export function buildPlanRequest(f: VlogForm): VlogPlanRequest {
  return {
    paths: f.paths,
    musicPath: f.musicPath,
    aspect: f.aspect,
    order: f.order,
    targetMs: f.length === "seconds" ? Math.round(f.seconds * 1000) : 0,
    beatCut: f.beatCut && f.musicPath !== "",
    transition: f.transition,
  };
}

/** Why the form can't be built yet ("" when it can). */
export function vlogProblem(f: VlogForm): string {
  if (f.paths.length === 0) return "Add some clips or photos";
  if (f.length === "seconds" && !(f.seconds >= 3 && f.seconds <= 1800)) return "The length is 3 seconds to 30 minutes";
  return "";
}
