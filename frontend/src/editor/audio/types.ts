/**
 * Preview audio and the playback clock (Phase 21 SPEC §B1). FROZEN after
 * Wave 0; E2 implements it in this folder.
 *
 * - The clock runs on AudioContext time and works with or without a song. It
 *   becomes the `PlayerController` (transport/player.ts) the shortcuts use,
 *   so seeks, J/K/L and reverse play (rate < 0, picture only) go through it.
 * - The mixer plays every clip's sound (video clips with audio, audio clips)
 *   and the song through one Web Audio graph, rescheduled on seek or edit.
 * - Peaks (`peaks.bin`, made by the prepare job) draw waveforms (E3).
 */
import type { Key } from "@/viz/edit/types";

/** The clock the transport registers as the PlayerController. */
export interface PlaybackClock {
  /** Timeline ms now. */
  now(): number;
  playing(): boolean;
  /** Plays from the playhead (or fromMs). rate 0.25..4; negative = reverse (no sound). */
  play(fromMs?: number, rate?: number): void;
  pause(): void;
  seek(ms: number): void;
  rate(): number;
  /** Loop play between in and out (Shift+L); null = off. */
  setLoop(range: { inMs: number; outMs: number } | null): void;
  /** The edit's length: the latest clip end, or the song length when longer. */
  lengthMs(): number;
}

/** One clip's sound, in timeline terms. */
export interface AudioClipPlan {
  clipId: string;
  trackId: string;
  /** The source file (its preview `audio.m4a` is what plays). */
  path: string;
  startMs: number; // timeline
  endMs: number; // timeline
  inMs: number; // source ms at startMs
  /** Constant-speed segments covering [startMs, endMs) (speed 1 = one segment). */
  speed: Array<{ fromMs: number; toMs: number; rate: number }>;
  /** Base linear gain (Clip.Volume, 0..2). */
  volume: number;
  /** Gain keys in dB (clip-relative ms), from Clip.Gain; empty = 0 dB. */
  gainKeys: Key[];
  gainBaseDb: number;
  fadeInMs: number;
  fadeOutMs: number;
}

export interface TrackAudio {
  trackId: string;
  gainDb: number;
  muted: boolean;
  solo: boolean;
}

/** Everything the mixer plays for a project. */
export interface ProjectAudio {
  clips: AudioClipPlan[];
  tracks: TrackAudio[];
  song: { path: string; startMs: number; endMs: number; gainDb: number; fadeInMs: number; fadeOutMs: number } | null;
}

export type AudioSourceState = "none" | "loading" | "ready" | "failed";

export interface Mixer {
  setProject(audio: ProjectAudio): void;
  /** Called by the clock on play/seek/pause. */
  start(atMs: number, rate: number): void;
  stop(): void;
  /** A 60 ms grain at ms (scrubbing). */
  scrub(ms: number): void;
  setScrubAudio(on: boolean): void;
  state(path: string): AudioSourceState;
  dispose(): void;
}

/** Waveform peaks from peaks.bin: min/max per 10 ms (int8, −127..127). */
export interface Peaks {
  rate: number; // samples per second (100)
  channels: number; // 1
  min: Int8Array;
  max: Int8Array;
  durationMs: number;
}

/** peaks.bin's first line (JSON), then the int8 min/max pairs. */
export interface PeaksHeader {
  v: 1;
  rate: number;
  channels: number;
}
