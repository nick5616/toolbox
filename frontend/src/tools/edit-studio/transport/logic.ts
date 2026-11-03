/** Pure helpers of the transport (Phase 9 SPEC §14.7, §14.11). */
import type { EditSong } from "@/lib/api";
import type { NormalProject } from "@/viz/edit/defaults";
import { laneSettings } from "@/viz/edit/defaults";
import { MARKER_LANES, type MarkerLane } from "@/viz/edit/types";

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Audio files a song can be. */
export const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".opus", ".wma", ".aiff", ".aif"];
/** What the song picker offers: audio, and videos (their sound). */
export const SONG_EXTENSIONS = [...AUDIO_EXTENSIONS, ".mp4", ".mov", ".mkv", ".webm", ".m4v"];

/** The song's volume 0..1 at timeline time t: gain (capped at 1) with the fades applied. */
export function songVolume(song: Pick<EditSong, "gainDb" | "fadeInMs" | "fadeOutMs">, tMs: number, durationMs: number): number {
  const gain = Math.min(1, 10 ** (song.gainDb / 20));
  const fin = song.fadeInMs > 0 ? clamp(tMs / song.fadeInMs, 0, 1) : 1;
  const fout = song.fadeOutMs > 0 ? clamp((durationMs - tMs) / song.fadeOutMs, 0, 1) : 1;
  return clamp(gain * fin * fout, 0, 1);
}

/** L pressed while playing: 1× → 1.5× → 2×. */
export function nextRate(rate: number): number {
  if (rate < 1.5) return 1.5;
  return 2;
}

/** The lanes shown (in lane order); 1..9 pick from this list. */
export function visibleLanes(p: Pick<NormalProject, "markers">): MarkerLane[] {
  return MARKER_LANES.filter((l) => laneSettings(p.markers, l).visible);
}

/** Pixels per second that fit durationMs into widthPx (clamped to the zoom limits). */
export function fitPps(widthPx: number, durationMs: number): number {
  if (durationMs <= 0 || widthPx <= 0) return 80;
  return clamp((widthPx * 1000) / durationMs, 6, 800);
}

/** One frame in ms at an fps. */
export function frameMs(fps: number): number {
  return 1000 / Math.max(1, fps);
}

/** Whether a replacement song file keeps the project's range (it still fits within a second). */
export function keepsRange(newDurationMs: number, song: Pick<EditSong, "endMs">): boolean {
  return newDurationMs > 0 && newDurationMs >= song.endMs - 1000;
}
