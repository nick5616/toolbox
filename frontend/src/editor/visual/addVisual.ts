/** Adds a visual clip (a Visualizer layer) at the playhead: screen blend, running to the end of the current section. */
import { toast } from "@/components";
import { deriveMarkers } from "@/viz/edit/markers";
import { defaultVisualClip, serializeVisualClip } from "@/viz/edit/schema";
import type { Marker } from "@/viz/edit/types";
import type { LayerType } from "@/viz/types";
import { useEditStudio } from "@/editor/store";
import { placeGenerated } from "../timeline/placeGenerated";

export const DEFAULT_VISUAL_MS = 4000;
export const MIN_VISUAL_MS = 2000;
export const MAX_VISUAL_MS = 16000;

/** Length of a new visual at `atMs`: to the end of the section marker that contains it (2..16 s), else 4 s. */
export function visualLengthAt(markers: readonly Marker[], atMs: number): number {
  const sec = markers.find((m) => m.lane === "section" && m.endMs !== undefined && m.ms <= atMs && m.endMs > atMs);
  if (!sec || sec.endMs === undefined) return DEFAULT_VISUAL_MS;
  return Math.max(MIN_VISUAL_MS, Math.min(MAX_VISUAL_MS, sec.endMs - atMs));
}

export function addVisualClip(layer: LayerType = "lightrays"): void {
  const st = useEditStudio.getState();
  const p = st.history?.present;
  if (!p) return;
  const start = p.song?.startMs ?? 0;
  const end = p.song?.endMs ?? 0;
  const markers = st.analysis && p.markers && end > start ? deriveMarkers(st.analysis, p.markers, { startMs: start, endMs: end }) : [];
  const res = placeGenerated(p, st.playheadMs, visualLengthAt(markers, st.playheadMs), { kind: "visual", visual: serializeVisualClip(defaultVisualClip(layer)), blend: "screen" });
  if (!res) {
    toast({ title: "No room for a visual here", description: "Free a track at the playhead or remove a track (8 at most).", tone: "warn" });
    return;
  }
  st.edit(res.project);
  st.select({ kind: "clips", ids: [res.clipId] });
}
