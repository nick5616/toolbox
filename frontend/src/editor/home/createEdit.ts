/** Creating an edit from the New edit dialog (Phase 9 SPEC §14.1), and the song setter shared with the "Use as the song?" confirm. */
import { EditStudioService, type EditSong } from "@/lib/api";
import { normalizeProject, type NormalProject } from "@/viz/edit/defaults";
import { trackPrepare } from "../sources/actions";
import { commit, currentDoc } from "../timeline/actions";
import { appendSources } from "../sources/tags";

export const MAX_SONG_MS = 600_000;
export const MIN_SONG_MS = 1000;

export interface NewEditForm {
  name: string;
  aspect: string;
  fps: number;
  /** "" = no song yet (Setup asks for one). */
  song: string;
  /** Photos and videos to queue as the edit's Sources. */
  sources: string[];
}

/** The default song record: the first 10 minutes at most, no fade in, a 500 ms fade out. */
export function songFor(path: string, durationMs: number): EditSong {
  return { path, startMs: 0, endMs: Math.min(Math.round(durationMs), MAX_SONG_MS), gainDb: 0, fadeInMs: 0, fadeOutMs: 500 };
}

/** File name without its extension. */
export function baseName(path: string): string {
  const n = path.split(/[\\/]/).pop() ?? path;
  const i = n.lastIndexOf(".");
  return i > 0 ? n.slice(0, i) : n;
}

/** Probes a song file: its length in ms, or throws a message fit for a toast. */
export async function probeSong(path: string): Promise<number> {
  const info = (await EditStudioService.Probe([path]))?.[0];
  if (!info || info.error || info.durationMs < MIN_SONG_MS) throw new Error(info?.error || "That file is too short or can't be read as a song.");
  return info.durationMs;
}

/** Makes `path` the open edit's song (range reset to its start) and clears the analysis, which sends the edit back to Setup. */
export async function useAsSong(path: string): Promise<void> {
  const dur = await probeSong(path);
  const doc = currentDoc();
  if (doc) commit({ ...doc, song: songFor(path, dur), analysisKey: "" });
}

/**
 * Create → set the song and the queued sources → Save, then start preparing
 * the sources. Returns the new edit's ID.
 */
export async function createEdit(f: NewEditForm): Promise<string> {
  const dur = f.song ? await probeSong(f.song) : 0;
  let media: string[] = [];
  if (f.sources.length) {
    const infos = (await EditStudioService.Probe(f.sources)) ?? [];
    media = infos.filter((i) => (i.kind === "video" || i.kind === "image") && !i.error).map((i) => i.path);
  }
  const name = f.name.trim() || (f.song ? baseName(f.song) : "Untitled edit");
  const info = await EditStudioService.Create(name, f.aspect, f.fps);
  let doc: NormalProject = normalizeProject(await EditStudioService.Get(info.id));
  if (f.song) doc = { ...doc, song: songFor(f.song, dur) };
  const { project, added } = appendSources(doc, media);
  await EditStudioService.Save(info.id, name, project);
  if (added.length) {
    try {
      trackPrepare(await EditStudioService.Prepare(info.id, added, f.fps));
    } catch {
      // The sources show "Not ready" with a Prepare button once the edit is open.
    }
  }
  return info.id;
}
