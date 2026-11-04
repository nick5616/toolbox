/**
 * Pure document edits for "Use" results of constituent tools (Phase 11 SPEC §6):
 * a clip's source file is swapped for the tool's result, or the music bed's
 * file is swapped for a stem. Both are single edits (one undo step).
 */
import type { NormalProject } from "@/viz/edit/defaults";
import { appendSources, relinkPath } from "../sources/tags";

/** How many other clips (not `clipId`) use `path`. */
export function otherUsers(doc: NormalProject, clipId: string, path: string): number {
  let n = 0;
  for (const t of doc.tracks) for (const c of t.clips) if (c.id !== clipId && c.path === path) n++;
  return n;
}

/** Points one clip at `to`, listing `to` in Sources. The old source stays listed. */
export function replaceInClip(doc: NormalProject, clipId: string, to: string): NormalProject {
  const { project } = appendSources(doc, [to]);
  return {
    ...project,
    tracks: project.tracks.map((t) => (t.clips.some((c) => c.id === clipId) ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, path: to } : c)) } : t)),
  };
}

/** Points every clip that uses `from` at `to` (and swaps it in Sources). */
export function replaceEverywhere(doc: NormalProject, from: string, to: string): NormalProject {
  return relinkPath(doc, from, to);
}

/** The music bed with another file, keeping range, gain and fades (the range is clamped to `fileMs` when known). */
export function replaceBedFile(doc: NormalProject, to: string, fileMs = 0): NormalProject {
  if (!doc.song) return doc;
  let { startMs, endMs } = doc.song;
  if (fileMs > 0 && endMs > fileMs) {
    endMs = Math.round(fileMs);
    startMs = Math.min(startMs, Math.max(0, endMs - 1000));
  }
  return { ...doc, song: { ...doc.song, path: to, startMs, endMs } };
}
