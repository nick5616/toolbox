/** Adds a text clip at the playhead (Part B; FX4 owns this folder and may refine the defaults). */
import { toast } from "@/components";
import { defaultTextClip, serializeTextClip } from "@/viz/edit/schema";
import { useEditStudio } from "../store";
import { placeGenerated } from "../timeline/placeGenerated";

export function addTextClip(text = "YOUR TEXT"): void {
  const st = useEditStudio.getState();
  const p = st.history?.present;
  if (!p) return;
  const res = placeGenerated(p, st.playheadMs, 2000, { kind: "text", text: serializeTextClip(defaultTextClip(text)), blend: "normal" });
  if (!res) {
    toast({ title: "No room for a text clip here", description: "Free a track at the playhead or remove a track (8 at most).", tone: "warn" });
    return;
  }
  st.edit(res.project);
  st.select({ kind: "clips", ids: [res.clipId] });
}
