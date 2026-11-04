/** Constituent tools offered on a selected clip (Phase 11 SPEC §6). */
import type { EditClip } from "@/lib/api";

export interface ToolChip {
  module: string;
  title: string;
  icon: string;
  tip: string;
}

const UPSCALE: ToolChip = { module: "upscaler", title: "Upscale", icon: "maximize", tip: "Make this photo sharper and larger; Use puts the result in this clip" };
const CLEAN: ToolChip = { module: "audio-cleanup", title: "Clean audio", icon: "audio-lines", tip: "Remove noise from this clip's sound; Use puts the result in this clip" };

/** The tools that apply to a clip of this kind, in bar order. */
export function clipToolChips(clip: Pick<EditClip, "kind" | "path">): ToolChip[] {
  if (!clip.path) return [];
  if (clip.kind === "image") return [UPSCALE];
  if (clip.kind === "video") return [CLEAN];
  return [];
}
