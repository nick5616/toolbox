/** One-line states for the designer's click-ins (SPEC §13: a hidden control never hides its state). */
import type { Analysis } from "@/viz/analysis";
import { PALETTES } from "@/viz/palette";
import type { Show } from "@/viz/types";
import { reactionMod, signalLabel } from "./model";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "7 layers" (the first scene's; a design with several scenes adds "· 3 scenes"). */
export function layersSummary(show: Show): string {
  const n = show.scenes[0]?.layers.length ?? 0;
  const s = plural(n, "layer");
  return show.scenes.length > 1 ? `${s} · ${show.scenes.length} scenes` : s;
}

const MODE_LABEL: Record<Show["palette"]["mode"], string> = { fixed: "", journey: "Journey", mood: "Mood", chords: "Chords", sections: "Sections" };

/** "Fire palette", "Journey of 3 palettes", "Mood colours". */
export function lookSummary(show: Show): string {
  const { mode, ids } = show.palette;
  const first = PALETTES.find((p) => p.id === ids[0])?.name ?? ids[0] ?? "";
  if (mode === "fixed") return first ? `${first} palette` : "Default palette";
  if (mode === "journey") return `Journey of ${plural(ids.length, "palette")}`;
  return `${MODE_LABEL[mode]} colours`;
}

/** "Kick → Bar height", "Kick → Bar height +3", "None yet". */
export function reactionsSummary(show: Show): string {
  const first = show.controls[0];
  if (!first) return "None yet";
  const mod = reactionMod(show, first);
  const head = mod ? `${signalLabel(mod.signal)} → ${first.label}` : first.label;
  return show.controls.length > 1 ? `${head} +${show.controls.length - 1}` : head;
}

/** "Auto · 5 sections", "Manual · 5 sections". */
export function timelineSummary(show: Show, analysis: Analysis): string {
  const mode = show.timeline.mode === "manual" ? "Manual" : "Auto";
  return `${mode} · ${plural(analysis.audio.sections.length, "section")}`;
}

export function presetSummary(show: Show): string {
  return show.name || "Custom design";
}
