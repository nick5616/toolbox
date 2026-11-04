/** The music bed's file: its length (cached), the "Add music" picker and Remove (SPEC §5.3). */
import { EditStudioService, FilesService, type EditSong } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { toast } from "@/components";
import type { NormalProject } from "@/viz/edit/defaults";
import { editLength } from "@/viz/edit/types";
import { SONG_EXTENSIONS } from "../transport/logic";
import { commit, currentDoc } from "./actions";

const MAX_BED_MS = 600_000;
const MIN_BED_MS = 1000;

const durations = new Map<string, Promise<number>>();

/** Length of an audio file in ms (0 when unknown); cached. */
export function fileDuration(path: string): Promise<number> {
  let p = durations.get(path);
  if (!p) {
    p = EditStudioService.Probe([path]).then((r) => r?.[0]?.durationMs ?? 0, () => 0);
    durations.set(path, p);
  }
  return p;
}

/** End of the last clip on any track (0 when there are none). */
export function clipsEndMs(p: Pick<NormalProject, "tracks">): number {
  let end = 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, c.endMs);
  return end;
}

/**
 * The music bed record for a file: from its start, as long as the clips
 * (at least 1 s), or as long as the file when there are no clips; never over 10 min.
 */
export function bedFor(p: NormalProject, path: string, durationMs: number): EditSong {
  const clipsEnd = clipsEndMs(p);
  const want = clipsEnd > 0 ? Math.max(clipsEnd, MIN_BED_MS) : durationMs;
  return { path, startMs: 0, endMs: Math.round(Math.min(durationMs, want, MAX_BED_MS)), gainDb: 0, fadeInMs: 0, fadeOutMs: 500 };
}

/** Picks an audio file and makes it the music bed of the open edit. */
export async function addMusic(path?: string): Promise<void> {
  try {
    let file = path;
    if (!file) file = ((await FilesService.PickWith("Add music", SONG_EXTENSIONS, false)) ?? [])[0];
    if (!file) return;
    const info = (await EditStudioService.Probe([file]))?.[0];
    if (!info || info.error || info.durationMs < MIN_BED_MS) throw new Error(info?.error || "That file is too short or can't be read as music.");
    const doc = currentDoc();
    if (doc) commit({ ...doc, song: bedFor(doc, file, info.durationMs) });
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}

/** Takes the music bed out of the open edit (undoable). */
export function removeMusic(): void {
  const doc = currentDoc();
  if (doc?.song) commit({ ...doc, song: null, analysisKey: "" });
}

/** Room the timeline shows: the edit itself with a song; with none, 30 s past the end and at least 60 s. */
export function timelineRoomMs(p: NormalProject): number {
  if (p.song) return editLength(p);
  const D = Math.max(editLength(p), clipsEndMs(p)); // without a song the edit follows its clips
  return Math.max(D + 30_000, 60_000);
}
