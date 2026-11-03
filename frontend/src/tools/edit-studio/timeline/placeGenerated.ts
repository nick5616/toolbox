/**
 * Where a new text or visual clip goes (Part B foundation): at the playhead,
 * on the topmost video track with room there, or on a new video track on top
 * (when there are fewer than 8). It lasts `lengthMs` or up to the next clip.
 */
import { newClip, newTrack } from "../doc";
import type { NormalProject } from "@/viz/edit/defaults";
import type { EditClip } from "@/lib/api";
import { editLength } from "@/viz/edit/types";

export const MIN_GENERATED_MS = 200;

export function placeGenerated(p: NormalProject, atMs: number, lengthMs: number, over: Partial<EditClip> & Pick<EditClip, "kind">): { project: NormalProject; clipId: string } | null {
  const D = editLength(p);
  const start = Math.max(0, Math.min(Math.round(atMs), Math.max(0, D - MIN_GENERATED_MS)));
  const want = Math.max(MIN_GENERATED_MS, Math.round(lengthMs));
  const tracks = [...p.tracks];
  for (let i = tracks.length - 1; i >= 0; i--) {
    const t = tracks[i];
    if (!t || t.kind !== "video" || t.locked) continue;
    if (t.clips.some((c) => c.startMs <= start && c.endMs > start)) continue;
    const next = t.clips.filter((c) => c.startMs > start).reduce((m, c) => Math.min(m, c.startMs), Number.POSITIVE_INFINITY);
    const end = Math.min(start + want, next, D > 0 ? D : start + want);
    if (end - start < MIN_GENERATED_MS) continue;
    const clip = newClip({ ...over, startMs: start, endMs: end });
    tracks[i] = { ...t, clips: [...t.clips, clip].sort((a, b) => a.startMs - b.startMs) };
    return { project: { ...p, tracks }, clipId: clip.id };
  }
  if (tracks.length >= 8) return null;
  const end = Math.min(start + want, D > 0 ? D : start + want);
  if (end - start < MIN_GENERATED_MS) return null;
  const clip = newClip({ ...over, startMs: start, endMs: end });
  const name = over.kind === "text" ? "Text" : "Visuals";
  const t = { ...newTrack("video", name), clips: [clip] };
  return { project: { ...p, tracks: [...tracks, t] }, clipId: clip.id };
}
