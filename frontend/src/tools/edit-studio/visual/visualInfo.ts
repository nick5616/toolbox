/** Names of the Visualizer layers offered as visual clips (Part B; FX5 owns this folder). */
import "@/viz/layers";
import { layerDef } from "@/viz/layers/registry";
import type { LayerType } from "@/viz/types";

export function visualLabel(layer: LayerType): string {
  return layerDef(layer)?.label ?? "Visual";
}
