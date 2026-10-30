/**
 * The handoff seed (SPEC.md §9.5): timed text sent from Lyric Video or
 * Subtitles. SourceStep takes the handoff and applies the words; this hook
 * looks at the same handoff first (a layout effect runs before SourceStep's
 * effect) and keeps the part SourceStep ignores, the look, in the store so the
 * Design step can start from Lyric Stage / Clean Captions with the tool's font
 * and colours.
 */
import { useLayoutEffect } from "react";
import { useUI } from "@/state/ui";
import { PRESETS } from "@/viz/presets";
import { showFromPreset } from "@/viz/presets";
import type { Show } from "@/viz/types";
import { applyTemplate, defaultTextStyle } from "./designer/model";
import { useVisualizer, type SeedLook } from "./store";

export const SEED_PRESET: Record<SeedLook["from"], string> = { "lyric-video": "lyric-stage", subtitles: "clean-captions" };

export function useSeed(moduleId: string): void {
  const handoff = useUI((s) => s.handoff);
  useLayoutEffect(() => {
    if (!handoff || handoff.moduleId !== moduleId || handoff.seed?.kind !== "timed-text") return;
    const s = useVisualizer.getState();
    s.setSeedLook({ from: handoff.seed.from, look: handoff.seed.look ?? null, overlay: !!handoff.seed.overlay });
    s.setShow(null); // the Design step starts again from the seeded preset
    s.setStep("source");
  }, [handoff, moduleId]);
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
