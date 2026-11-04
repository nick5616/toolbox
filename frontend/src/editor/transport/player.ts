/**
 * The playback controller (Phase 9 SPEC §14.7). The Transport registers the
 * hidden audio player's controls here so the keyboard shortcuts and palette
 * commands can drive playback without prop drilling. Without a registered
 * player (Setup, no song) the helpers only move the playhead.
 */
import { useEditStudio } from "@/editor/store";

export interface PlayerController {
  /** Plays at 1× (restarts at 0 when at the end). */
  play(): void;
  pause(): void;
  toggle(): void;
  /** Seeks to timeline ms (the store's playhead follows). */
  seek(ms: number): void;
  setRate(rate: number): void;
  rate(): number;
}

let current: PlayerController | null = null;

export function registerPlayer(c: PlayerController): () => void {
  current = c;
  return () => {
    if (current === c) current = null;
  };
}

export function getPlayer(): PlayerController | null {
  return current;
}

/** Moves the playhead (and the audio when there is a player). */
export function seekTo(ms: number): void {
  const t = Math.max(0, ms);
  if (current) current.seek(t);
  else useEditStudio.getState().setPlayhead(t);
}
