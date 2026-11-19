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

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** "HH:MM:SS:FF" for a time in ms at an fps (frames are whole; the last frame of a second is fps−1). */
export function formatTimecode(ms: number, fps: number): string {
  const base = Math.max(1, Math.round(fps));
  const total = Math.max(0, Math.floor((ms * base) / 1000 + 1e-6));
  const ff = total % base;
  const secs = Math.floor(total / base);
  return `${pad2(Math.floor(secs / 3600))}:${pad2(Math.floor(secs / 60) % 60)}:${pad2(secs % 60)}:${pad2(ff)}`;
}

/**
 * Time typed into the timecode: "HH:MM:SS:FF", "MM:SS:FF", "SS:FF", plain
 * seconds ("12", "12.5") or "M:SS.s" (a decimal point means seconds, not
 * frames). Null when it isn't a time or a frame number is out of range.
 */
export function parseTimecode(text: string, fps: number): number | null {
  const t = text.trim().replace(/;/g, ":");
  if (!t) return null;
  const base = Math.max(1, Math.round(fps));
  const parts = t.split(":");
  if (parts.length > 4 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(Number);
  if (t.includes(".")) {
    // M:SS.s style: only the last part may have a decimal; the parts are h/m/s from the right
    if (parts.slice(0, -1).some((p) => p.includes("."))) return null;
    const [s = 0, m = 0, h = 0] = [...nums].reverse();
    return Math.round(((h * 60 + m) * 60 + s) * 1000);
  }
  if (nums.length === 1) return Math.round((nums[0] as number) * 1000);
  const ff = nums[nums.length - 1] as number;
  if (ff >= base) return null;
  const [s = 0, m = 0, h = 0] = nums.slice(0, -1).reverse();
  if (s >= 60 || (nums.length > 2 && m >= 60)) return null;
  return Math.round(((h * 3600 + m * 60 + s) * base + ff) * (1000 / base));
}
