/** Adds a visual clip (a Visualizer layer) at the playhead (Part B; FX5 refines). */
import { toast } from "@/components";
import { defaultVisualClip, serializeVisualClip } from "@/viz/edit/schema";
import type { LayerType } from "@/viz/types";
import { useEditStudio } from "../store";
import { placeGenerated } from "../timeline/placeGenerated";

export function addVisualClip(layer: LayerType = "lightrays"): void {
  const st = useEditStudio.getState();
  const p = st.history?.present;
  if (!p) return;
  const res = placeGenerated(p, st.playheadMs, 4000, { kind: "visual", visual: serializeVisualClip(defaultVisualClip(layer)), blend: "screen" });
  if (!res) {
    toast({ title: "No room for a visual here", description: "Free a track at the playhead or remove a track (8 at most).", tone: "warn" });
    return;
  }
  st.edit(res.project);
  st.select({ kind: "clips", ids: [res.clipId] });
}
