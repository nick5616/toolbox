/** Pure helpers for the Visuals step and the visuals background (SPEC.md §9.2). */
import { PackComponentState, type AnalyzeOptions, type TimedLine, type VisualsSpec } from "@/lib/api";
import { pickerAnalyzeOptions, parseShow } from "@/components/viz/pickerModel";
import type { ToolSeed } from "@/state/ui";
import { withoutText } from "@/tools/visualizer/designer/model";
import { applyTemplate } from "@/tools/visualizer/designer/model";
import { PRESETS, presetById, showFromPreset } from "@/viz/presets";
import type { Show } from "@/viz/types";
import type { PackView } from "@/views/setup/packSizes";
import type { RememberedLook, VisualsMode } from "./options";

export const STEMS_MODEL = "stems-default";

/** True when a pack component is present on this machine. */
export function componentInstalled(packs: readonly PackView[], id: string): boolean {
  for (const p of packs) {
    const c = p.components.find((x) => x.id === id);
    if (c) return c.state === PackComponentState.ComponentInstalled || c.state === PackComponentState.ComponentSystem;
  }
  return false;
}

export const ASPECT_VALUE: Record<string, number> = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1 };
export const aspectNumber = (aspect: string): number => ASPECT_VALUE[aspect] ?? 16 / 9;

/** The analyze options of the Visuals step: the sheet as given words, the mood reader on. */
export function stepAnalyzeOptions(o: {
  stems: boolean;
  saveStems: boolean;
  useWords: boolean;
  lines: TimedLine[];
  moodReady: boolean;
}): AnalyzeOptions {
  const base = pickerAnalyzeOptions({ stems: o.stems, useWords: o.useWords, lines: o.lines, moodReady: o.moodReady });
  return { ...base, saveStems: o.stems && o.saveStems };
}

/** The show of a spec, or null when none is chosen. */
export function showOf(spec: VisualsSpec): Show | null {
  return parseShow(spec.showJson);
}

/** What the Look preview draws behind the lyrics (text is the HTML preview's job). */
export function previewShow(spec: VisualsSpec): Show | null {
  const s = showOf(spec);
  return s ? withoutText(s) : null;
}

/** The name shown for the chosen design: a preset's name, "Custom design" or "Classic". */
export function designLabel(look: Pick<RememberedLook, "background" | "visuals">): string {
  if (look.background !== "visualizer") return "Classic";
  const show = showOf(look.visuals);
  if (!show) return "Classic";
  const preset = show.presetId ? presetById(show.presetId) : undefined;
  if (preset && JSON.stringify(withoutText(show)) === JSON.stringify(withoutText(showFromPreset(preset)))) return preset.name;
  return "Custom design";
}

/** The design the full designer starts from: Lyric Stage when there is one, else the first preset. */
export function initialDesign(): Show | null {
  const preset = presetById("lyric-stage") ?? PRESETS[0];
  return preset ? applyTemplate(showFromPreset(preset), { mode: "full", engineText: false }) : null;
}

/** The Look with the visuals mode applied (Classic drops the visuals background). */
export function lookForMode(look: RememberedLook, mode: VisualsMode): RememberedLook {
  if (mode === "classic") return look.background === "visualizer" ? { ...look, background: "blur-cover" } : look;
  return look.visuals.showJson !== "" && look.background !== "visualizer" ? { ...look, background: "visualizer" } : look;
}

/** The seed that hands the sheet and its look to the Visualizer. */
export function visualizerSeed(lines: TimedLine[], look: RememberedLook): ToolSeed {
  return {
    kind: "timed-text",
    from: "lyric-video",
    lines,
    look: {
      font: look.font,
      textColor: look.textColor,
      highlightColor: look.highlightColor,
      karaoke: look.karaoke,
      position: look.position === "lower" ? "lower" : "center",
    },
  };
}
