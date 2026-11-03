/**
 * Split subject (Phase 9 SPEC §10.7). The timeline's clip menu (WP-ES2) and the Cut-out section call it.
 */
import type { EditClip } from "@/lib/api";
import type { NormalProject } from "@/viz/edit/defaults";
import { findClip, newId } from "../doc";

/** Tracks per project (Go MaxTracks, §15). */
const MAX_TRACKS = 8;

/**
 * Duplicates a clip with a matte onto a new video track directly above (same timing, cutout on, effects
 * cleared on the copy). The lower clip stays as the background: if it was a cut-out itself, its cut-out turns
 * off (the subject now lives on the copy). The copy is muted (the original keeps the sound). Null when the
 * clip has no matte, isn't on a video track, or there are already 8 tracks.
 */
export function splitSubject(p: NormalProject, clipId: string): NormalProject | null {
  const ref = findClip(p, clipId);
  if (!ref || !ref.clip.matte || ref.track.kind !== "video" || (ref.clip.kind !== "video" && ref.clip.kind !== "image")) return null;
  if (p.tracks.length >= MAX_TRACKS) return null;
  const matte = ref.clip.matte;
  const copy: EditClip = {
    ...ref.clip,
    id: newId("c"),
    matte: { ...matte, cutout: true },
    effects: "",
    fxTarget: "clip",
    volume: 0,
    pinned: false,
    auto: false,
  };
  const above: NormalProject["tracks"][number] = {
    id: newId("t"),
    kind: "video",
    name: `${ref.track.name} subject`.slice(0, 40),
    muted: false,
    locked: false,
    clips: [copy],
  };
  const tracks = p.tracks.map((t, i) => {
    if (i !== ref.trackIndex || !matte.cutout) return t;
    return { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, matte: { ...matte, cutout: false }, auto: false } : c)) };
  });
  tracks.splice(ref.trackIndex + 1, 0, above);
  return { ...p, tracks };
}
