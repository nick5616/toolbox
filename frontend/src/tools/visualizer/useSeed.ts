/**
 * The handoff seed (SPEC.md §9.5): timed text sent from Lyric Video or
 * Subtitles. `applyHandoff` (called by the view through `useToolHandoff`)
 * puts the lines into the analysis options and keeps the look in the store so
 * the workspace can start from Lyric Stage / Clean Captions with the tool's
 * font and colours.
 */
import { WordsSource } from "@/lib/api";
import type { Handoff, ToolSeed } from "@/state/ui";
import { PRESETS } from "@/viz/presets";
import { showFromPreset } from "@/viz/presets";
import type { Show } from "@/viz/types";
import { applyTemplate, defaultTextStyle } from "@/blocks/visuals/designer/model";
import { isVideoPath } from "./source/logic";
import { useVisualizer, type SeedLook } from "./store";

export const SEED_PRESET: Record<SeedLook["from"], string> = { "lyric-video": "lyric-stage", subtitles: "clean-captions" };

/** Applies a handed-over timed-text seed to the store (words, mode, look; the design restarts from the seeded preset). */
export function applySeed(seed: ToolSeed): void {
  const s = useVisualizer.getState();
  s.setSeed(seed.from, seed.lines);
  s.setAnalyze({ words: WordsSource.WordsGiven, lines: seed.lines, mood: true });
  if (seed.overlay) s.setMode("overlay");
  s.setSeedLook({ from: seed.from, look: seed.look ?? null, overlay: !!seed.overlay });
  s.setShow(null); // the workspace starts again from the seeded preset
}

/** A dropped/handed-over input and its optional timed-text seed. */
export function applyHandoff(h: Handoff): void {
  const first = h.inputs[0];
  const s = useVisualizer.getState();
  if (first) s.setInput(first, isVideoPath(first));
  if (h.seed?.kind === "timed-text") {
    applySeed(h.seed);
    // A seed without a new file changes the words: the song is analysed again.
    if (!first) s.setAnalysis(null, null);
  }
}

/** The starting design for a timed-text seed: the tool's preset, else the first one, with its look as the text style. */
export function seededShow(seed: SeedLook, mode: "full" | "overlay"): Show | null {
  const preset = PRESETS.find((p) => p.id === SEED_PRESET[seed.from]) ?? PRESETS[0];
  if (!preset) return null;
  const subtitles = seed.from === "subtitles";
  const base = applyTemplate(showFromPreset(preset), { mode, engineText: true });
  const text = base.text ?? defaultTextStyle(subtitles ? "subtitle" : "karaoke");
  const look = seed.look;
  return {
    ...base,
    name: preset.name,
    presetId: preset.id,
    text: look
      ? {
          ...text,
          font: look.font || text.font,
          color: look.textColor || text.color,
          highlight: look.highlightColor || text.highlight,
          preset: look.karaoke ? "karaoke" : subtitles ? "subtitle" : text.preset === "karaoke" ? "pop" : text.preset,
          position: look.position === "lower" ? "lower" : "center",
        }
      : text,
  };
}
