/** The Visualizer layers offered as visual clips: names, groups, the suggested row, palette labels. */
import "@/viz/layers";
import { layerDef, layerDefs, type LayerDef } from "@/viz/layers/registry";
import { PALETTES } from "@/viz/palette";
import type { LayerType, PaletteId } from "@/viz/types";

export function visualLabel(layer: LayerType): string {
  return layerDef(layer)?.label ?? "Visual";
}

export const SUGGESTED_LAYERS: readonly LayerType[] = ["lightrays", "embers", "shockwave", "bursts", "starfield", "tunnel", "sweep", "ripples", "fireflies", "frame"];

const GROUP_ORDER: readonly LayerDef["group"][] = ["background", "shape", "particles", "accent", "highway", "motif"];
const GROUP_LABEL: Record<LayerDef["group"], string> = { background: "Background", shape: "Shape", particles: "Particles", accent: "Accent", highway: "Highway", motif: "Motif" };

/** Every layer that can be a clip: stateful layers (they read their previous frame) are not offered. */
export function offeredLayers(): LayerDef[] {
  return layerDefs().filter((d) => !d.stateful);
}

export interface LayerGroup {
  group: LayerDef["group"];
  label: string;
  layers: LayerDef[];
}

export function offeredGroups(): LayerGroup[] {
  const all = offeredLayers();
  return GROUP_ORDER.map((g) => ({ group: g, label: GROUP_LABEL[g], layers: all.filter((d) => d.group === g) })).filter((g) => g.layers.length > 0);
}

/** The suggested layers that exist and are offered. */
export function suggestedLayers(): LayerDef[] {
  const offered = offeredLayers();
  return SUGGESTED_LAYERS.map((t) => offered.find((d) => d.type === t)).filter((d): d is LayerDef => d !== undefined);
}

export const PALETTE_OPTIONS: ReadonlyArray<{ value: PaletteId; label: string }> = PALETTES.map((p) => ({ value: p.id, label: p.name }));
