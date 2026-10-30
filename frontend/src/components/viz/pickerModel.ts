/** Pure helpers behind the VisualsPicker. */
import { WordsSource, type AnalyzeOptions, type TimedLine } from "@/lib/api";
import { PALETTES } from "@/viz/palette";
import { PRESETS, showFromPreset } from "@/viz/presets";
import type { PaletteId, Show } from "@/viz/types";
import { validateShow } from "@/viz/validate";
import type { ThumbItem } from "./PresetThumbs";

/** The eight palettes offered as swatches. */
export const SWATCH_PALETTES = PALETTES.slice(0, 8);

export const CUSTOM_ID = "custom";

export function parseShow(json: string | undefined | null): Show | null {
  if (!json) return null;
  try {
    const r = validateShow(JSON.parse(json));
    return r.ok ? r.show : null;
  } catch {
    return null;
  }
}

export function withReactivity(show: Show, reactivity: number): Show {
  return { ...show, reactivity: Math.min(2, Math.max(0, reactivity)) };
}

export function withFixedPalette(show: Show, id: PaletteId): Show {
  return { ...show, palette: { mode: "fixed", ids: [id] } };
}

export function withPalette(show: Show, palette: Show["palette"]): Show {
  return { ...show, palette: { mode: palette.mode, ids: [...palette.ids] } };
}

/** The palette id when the show uses a single fixed palette, else null. */
export function fixedPaletteId(show: Show): PaletteId | null {
  return show.palette.mode === "fixed" && show.palette.ids.length === 1 ? (show.palette.ids[0] ?? null) : null;
}

/** Saved designs (VisualizerService.Designs) as cards; invalid ones are skipped. */
export function readMyDesigns(list: ReadonlyArray<{ id: string; name: string; showJson: string }> | null): ThumbItem[] {
  const out: ThumbItem[] = [];
  for (const e of list ?? []) {
    const r = validateShow(safeParse(e.showJson));
    if (!r.ok) continue;
    const name = e.name || r.show.name || "My design";
    out.push({ id: `mine:${e.id || name}`, name, description: "Saved in the Visualizer", show: { ...r.show, text: null }, kind: "mine" });
  }
  return out;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Preset cards; in overlay mode the overlay presets come first. */
export function presetItems(mode: "background" | "overlay"): ThumbItem[] {
  // The host tool draws its own words, so the picker's designs never carry text.
  const items: ThumbItem[] = PRESETS.map((p) => ({ id: p.id, name: p.name, description: p.description, show: { ...showFromPreset(p), text: null }, kind: "preset" as const }));
  if (mode !== "overlay") return items;
  const first = new Set(PRESETS.filter((p) => p.overlayFirst).map((p) => p.id));
  return [...items.filter((i) => first.has(i.id)), ...items.filter((i) => !first.has(i.id))];
}

/**
 * Which card the value selects: a saved design with the same JSON, a preset by
 * `presetId`, otherwise the custom card.
 */
export function selectedIdFor(show: Show | null, mine: ThumbItem[], presets: ThumbItem[]): string | null {
  if (!show) return null;
  const json = JSON.stringify(show);
  const m = mine.find((i) => JSON.stringify(i.show) === json);
  if (m) return m.id;
  const p = show.presetId ? presets.find((i) => i.id === show.presetId) : undefined;
  return p ? p.id : CUSTOM_ID;
}

/** The analyze options the picker asks for (SPEC.md §9.1). */
export function pickerAnalyzeOptions(o: { stems: boolean; useWords: boolean; lines: TimedLine[] | null; moodReady: boolean }): AnalyzeOptions {
  const words = o.useWords && o.lines && o.lines.length > 0;
  return {
    stems: o.stems,
    saveStems: false,
    words: words ? WordsSource.WordsGiven : WordsSource.WordsNone,
    language: "",
    lyricsText: "",
    lyricsPath: "",
    lines: words ? o.lines : null,
    mood: Boolean(words && o.moodReady),
    deepRead: false,
  };
}
