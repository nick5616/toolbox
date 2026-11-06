/** Adds a text clip at the playhead: up to the next downbeat (1 to 4 s) when the song has markers, else 2 s. */
import { toast } from "@/components";
import { deriveMarkers } from "@/viz/edit/markers";
import { defaultTextClip, serializeTextClip } from "@/viz/edit/schema";
import type { Marker } from "@/viz/edit/types";
import { useEditStudio } from "@/editor/store";
import { placeGenerated } from "../timeline/placeGenerated";

export const DEFAULT_TEXT_MS = 2000;
export const MIN_TEXT_MS = 1000;
export const MAX_TEXT_MS = 4000;

/** The length of a new text clip placed at `atMs`: to the next downbeat after it, clamped to 1..4 s; 2 s without markers. */
export function textLengthAt(markers: readonly Marker[], atMs: number): number {
  const next = markers.filter((m) => m.lane === "downbeat" && m.ms > atMs).reduce((best, m) => Math.min(best, m.ms), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(next)) return DEFAULT_TEXT_MS;
  return Math.max(MIN_TEXT_MS, Math.min(MAX_TEXT_MS, Math.round(next - atMs)));
}

export function addTextClip(text = "YOUR TEXT"): void {
  const st = useEditStudio.getState();
  const p = st.history?.present;
  if (!p) return;
  const song = p.song;
  const markers = st.analysis && p.markers && song && song.endMs > song.startMs ? deriveMarkers(st.analysis, p.markers, { startMs: song.startMs, endMs: song.endMs }) : [];
  const res = placeGenerated(p, st.playheadMs, textLengthAt(markers, st.playheadMs), { kind: "text", text: serializeTextClip(defaultTextClip(text)), blend: "normal" });
  if (!res) {
    toast({ title: "No room for a text clip here", description: "Free a track at the playhead or remove a track (8 at most).", tone: "warn" });
    return;
  }
  st.edit(res.project);
  st.select({ kind: "clips", ids: [res.clipId] });
}
