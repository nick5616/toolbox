/**
 * The Video Editor's "New video" (Phase 10 SPEC §5.4): files become clips one
 * after another on track 1 (photos 3 s each); the first audio file becomes the
 * music bed. No song and no analysis are needed.
 */
import type { EditSong, VideoClipInfo } from "@/lib/api";
import { EditStudioService } from "@/lib/api";
import { normalizeProject, type NormalProject } from "@/viz/edit/defaults";
import { newClip } from "../doc";
import { trackPrepare } from "../sources/actions";
import { appendSources } from "../sources/tags";
import { commit, currentDoc } from "../timeline/actions";
import { baseName, MAX_SONG_MS, MIN_SONG_MS, probeSong } from "./createEdit";

export const IMAGE_CLIP_MS = 3000;

export interface NewVideoForm {
  name: string;
  aspect: string;
  fps: number;
  /** Videos, photos and audio, in the order they should appear. */
  files: string[];
}

type Probed = Pick<VideoClipInfo, "path" | "kind" | "durationMs" | "error">;

/**
 * Lays probed files out on track 1 back to back and picks the music bed. The
 * bed runs for min(its length, the clips' end, 10 minutes), or its own length
 * with no clips.
 */
export function layoutFiles(doc: NormalProject, infos: readonly Probed[]): { project: NormalProject; media: string[] } {
  const clips: NormalProject["tracks"][number]["clips"] = [];
  const media: string[] = [];
  let cursor = 0;
  let song: { path: string; durationMs: number } | null = null;
  for (const i of infos) {
    if (i.error) continue;
    if (i.kind === "audio") {
      if (!song && i.durationMs >= MIN_SONG_MS) song = { path: i.path, durationMs: Math.round(i.durationMs) };
      continue;
    }
    if (i.kind !== "video" && i.kind !== "image") continue;
    const len = i.kind === "video" && i.durationMs > 0 ? Math.round(i.durationMs) : IMAGE_CLIP_MS;
    clips.push(newClip({ kind: i.kind, path: i.path, startMs: cursor, endMs: cursor + len, ...(i.kind === "video" ? { volume: 1 } : {}) }));
    media.push(i.path);
    cursor += len;
  }
  const tracks = doc.tracks.slice();
  const first = tracks[0];
  if (first) tracks[0] = { ...first, clips: [...first.clips, ...clips] };
  let project: NormalProject = { ...doc, tracks };
  if (song) project = { ...project, song: musicBed(song.path, song.durationMs, cursor) };
  return { project: appendSources(project, media).project, media };
}

/** The music bed for an audio file: min(its length, the clips' end, 10 minutes); its own length with no clips. */
export function musicBed(path: string, durationMs: number, clipsEndMs: number): EditSong {
  const end = Math.max(MIN_SONG_MS, Math.min(durationMs, clipsEndMs > 0 ? clipsEndMs : durationMs, MAX_SONG_MS));
  return { path, startMs: 0, endMs: Math.round(end), gainDb: 0, fadeInMs: 0, fadeOutMs: 500 };
}

/** Makes `path` the open video's music bed; the analysis (if any) is left alone. */
export async function setMusicBed(path: string): Promise<void> {
  const dur = await probeSong(path);
  const doc = currentDoc();
  if (!doc) return;
  const clipsEnd = doc.tracks.reduce((m, t) => t.clips.reduce((mm, c) => Math.max(mm, c.endMs), m), 0);
  commit({ ...doc, song: musicBed(path, dur, clipsEnd) });
}

/** Creates the video (no song needed), places the files, saves, and starts preparing the clips. Returns its ID. */
export async function createVideo(f: NewVideoForm): Promise<string> {
  const infos = f.files.length ? ((await EditStudioService.Probe(f.files)) ?? []) : [];
  const first = f.files[0];
  const name = f.name.trim() || (first ? baseName(first) : "Untitled video");
  const info = await EditStudioService.Create(name, f.aspect, f.fps);
  const doc = normalizeProject(await EditStudioService.Get(info.id));
  const { project, media } = layoutFiles(doc, infos);
  await EditStudioService.Save(info.id, name, project);
  if (media.length) {
    try {
      trackPrepare(await EditStudioService.Prepare(info.id, media, f.fps));
    } catch {
      // The clips show "Not ready" with a Prepare button once the video is open.
    }
  }
  return info.id;
}
