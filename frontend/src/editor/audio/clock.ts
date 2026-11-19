/**
 * The playback clock (Phase 21 SPEC §B1): timeline time from
 * `AudioContext.currentTime`, so it runs with or without a song. Pure apart
 * from the context's time; the player (transport/player.ts) calls `update()`
 * once per animation frame, which handles the end of the edit and the loop.
 *
 * Rates: 0.25..4 forward; a negative rate plays the picture backwards and
 * makes no sound (the mixer is stopped).
 */
import type { Mixer, PlaybackClock } from "./types";

export const MIN_RATE = 0.25;
export const MAX_RATE = 4;

/** What the clock needs from an AudioContext. */
export interface ClockContext {
  readonly currentTime: number;
  readonly state?: string;
  resume?(): Promise<void>;
}

export interface ClockDeps {
  ctx: ClockContext;
  /** The mixer to start/stop alongside (optional). */
  mixer?: Pick<Mixer, "start" | "stop"> | null;
  /** The edit's length in ms. */
  length: () => number;
  /** Called when playback stopped by itself (end of the edit, start when reversing). */
  onEnd?: () => void;
}

export interface Clock extends PlaybackClock {
  /** Handles the end of the edit and the loop; returns now(). Call once per frame while playing. */
  update(): number;
  /** Changes the speed (restarts from now when playing). */
  setRate(rate: number): void;
}

/** Clamps |rate| to 0.25..4, keeping the sign; 0 and NaN become 1. */
export function normalizeRate(rate: number): number {
  if (!Number.isFinite(rate) || rate === 0) return 1;
  return Math.sign(rate) * Math.min(MAX_RATE, Math.max(MIN_RATE, Math.abs(rate)));
}

export function createClock(deps: ClockDeps): Clock {
  const { ctx } = deps;
  let posMs = 0;
  let t0 = 0;
  let rate = 1;
  let isPlaying = false;
  let loop: { inMs: number; outMs: number } | null = null;

  const len = () => Math.max(0, deps.length());
  const raw = () => posMs + (ctx.currentTime - t0) * 1000 * rate;
  const clampLen = (ms: number) => Math.max(0, Math.min(len(), ms));

  const begin = (from: number, r: number) => {
    posMs = from;
    t0 = ctx.currentTime;
    rate = r;
    isPlaying = true;
    deps.mixer?.start(from, r);
  };

  const stopAt = (ms: number) => {
    posMs = clampLen(ms);
    isPlaying = false;
    rate = 1;
    deps.mixer?.stop();
  };

  const clock: Clock = {
    now: () => (isPlaying ? clampLen(raw()) : posMs),
    playing: () => isPlaying,
    rate: () => rate,
    lengthMs: len,
    play(fromMs, r = 1) {
      const next = normalizeRate(r);
      const total = len();
      if (total <= 0) return;
      let from = clampLen(fromMs ?? (isPlaying ? raw() : posMs));
      if (next > 0 && from >= total) from = 0; // play at the end restarts
      if (next < 0 && from <= 0) {
        stopAt(0); // nothing before the start
        return;
      }
      if (ctx.state === "suspended") void ctx.resume?.();
      begin(from, next);
    },
    pause() {
      if (!isPlaying) return;
      stopAt(raw());
    },
    seek(ms) {
      const to = clampLen(ms);
      if (isPlaying) begin(to, rate);
      else posMs = to;
    },
    setRate(r) {
      const next = normalizeRate(r);
      if (isPlaying) begin(clampLen(raw()), next);
      else rate = next;
    },
    setLoop(range) {
      if (!range) {
        loop = null;
        return;
      }
      const a = Math.max(0, Math.min(range.inMs, range.outMs));
      const b = Math.max(range.inMs, range.outMs);
      loop = b - a >= 1 ? { inMs: a, outMs: b } : null;
    },
    update() {
      if (!isPlaying) return posMs;
      const r = raw();
      if (loop) {
        const out = Math.min(loop.outMs, len());
        if (rate > 0 && r >= out) {
          begin(loop.inMs, rate);
          return posMs;
        }
        if (rate < 0 && r <= loop.inMs) {
          begin(out, rate);
          return posMs;
        }
      }
      const total = len();
      if (rate > 0 && r >= total) {
        stopAt(total);
        deps.onEnd?.();
      } else if (rate < 0 && r <= 0) {
        stopAt(0);
        deps.onEnd?.();
      }
      return clock.now();
    },
  };
  return clock;
}
