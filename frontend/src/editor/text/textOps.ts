/** Pure document operations for text clips: quick styles and "Text through video". */
import type { EditClip } from "@/lib/api";
import type { TextClip } from "@/viz/edit/types";
import { findClip, newId, newTrack, type NormalProject } from "@/editor/doc";

export const MAX_TRACKS = 8;

export interface QuickStyle {
  id: string;
  label: string;
  apply(t: TextClip): TextClip;
}

const withStyle = (t: TextClip, s: Partial<TextClip["style"]>): TextClip => ({ ...t, style: { ...t.style, ...s } });

export const QUICK_STYLES: readonly QuickStyle[] = [
  { id: "big-punch", label: "Big punch", apply: (t) => withStyle(t, { preset: "pop", weight: 900, uppercase: true, outline: 0.08, size: 10, position: "center" }) },
  { id: "glow", label: "Glow", apply: (t) => withStyle(t, { glow: 1 }) },
  { id: "typewriter", label: "Typewriter", apply: (t) => withStyle(t, { preset: "typewriter", weight: 700, uppercase: false }) },
  { id: "subtitle", label: "Subtitle", apply: (t) => withStyle(t, { preset: "subtitle", weight: 700, uppercase: false, size: 5, position: "lower", outline: 0.04, glow: 0 }) },
  // The outline colour is fixed (dark), so "no fill" is approximated by the thickest outline on white, softly fading words.
  { id: "outline", label: "Outline only", apply: (t) => withStyle(t, { preset: "fade", weight: 900, uppercase: true, outline: 0.15, glow: 0, color: "#ffffff" }) },
];

export type ThroughVideoResult = { ok: true; project: NormalProject; trackId: string } | { ok: false; reason: string };

/**
 * Inserts a video track directly below the text clip's track, holding a copy
 * of the clip under the playhead on the tracks below, matted by the text
 * track (alpha): the text becomes a window into that video.
 */
export function textThroughVideo(p: NormalProject, textClipId: string, playheadMs: number): ThroughVideoResult {
  const ref = findClip(p, textClipId);
  if (!ref) return { ok: false, reason: "That text clip is gone." };
  if (p.tracks.length >= MAX_TRACKS) return { ok: false, reason: "The edit already has 8 tracks. Remove one first." };
  let src: EditClip | null = null;
  for (let i = ref.trackIndex - 1; i >= 0 && !src; i--) {
    const t = p.tracks[i];
    if (!t || t.kind !== "video" || t.muted) continue;
    src = t.clips.find((c) => c.kind !== "text" && c.kind !== "visual" && c.startMs <= playheadMs && c.endMs > playheadMs) ?? null;
  }
  if (!src) return { ok: false, reason: "Put a video or photo under the text at the playhead first." };
  const track = { ...newTrack("video", "Text video"), matte: "alpha", clips: [{ ...src, id: newId("c") }] };
  const tracks = p.tracks.slice();
  tracks.splice(ref.trackIndex, 0, track);
  return { ok: true, project: { ...p, tracks }, trackId: track.id };
}
