/**
 * The playback controller (Phase 9 SPEC §14.7, Phase 21 §B1). The Transport
 * registers it here so the keyboard shortcuts and palette commands can drive
 * playback without prop drilling. It runs the audio clock (works with or
 * without a song) and writes the playhead into the store once per animation
 * frame. Without a registered player (Setup) the helpers only move the playhead.
 */
import { useEditStudio } from "@/editor/store";
import type { Clock } from "@/editor/audio/clock";
import type { MixerImpl } from "@/editor/audio/mixer";

export interface PlayerController {
  /** Plays at 1× (restarts at 0 when at the end). */
  play(): void;
  pause(): void;
  toggle(): void;
  /** Seeks to timeline ms (the store's playhead follows). */
  seek(ms: number): void;
  /** Changes the speed (0.25..4); only the next play when paused. */
  setRate(rate: number): void;
  rate(): number;
  /** J: plays backwards at −1×; again −2×, then −4×. Picture only, no sound. */
  reverse(): void;
  /** Loops between in and out while playing (Shift+L); null = off. */
  loop(range: { inMs: number; outMs: number } | null): void;
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

/**
 * The playhead rounded down to a multiple of stepMs, for components that
 * don't need every frame (they re-render only when the step changes).
 */
export function usePlayheadCoarse(stepMs: number): number {
  const step = Math.max(1, stepMs);
  return useEditStudio((s) => Math.floor(s.playheadMs / step) * step);
}

export interface PlayerDeps {
  clock: Clock;
  mixer?: Pick<MixerImpl, "scrub"> | null;
  store?: typeof useEditStudio;
  raf?: (cb: () => void) => unknown;
  caf?: (handle: unknown) => void;
}

export interface Player extends PlayerController {
  playing(): boolean;
  /** Timeline ms now (the clock's, not the store's). */
  now(): number;
  /** Runs one frame: clock.update(), then the store (the frame loop calls it; tests call it directly). */
  frame(): void;
  dispose(): void;
}

/** The controller over a clock: one frame loop while playing, the store kept in step both ways. */
export function createPlayer(deps: PlayerDeps): Player {
  const { clock } = deps;
  const store = deps.store ?? useEditStudio;
  const raf = deps.raf ?? ((cb: () => void) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(cb) : setTimeout(cb, 16)));
  const caf = deps.caf ?? ((h: unknown) => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(h as number) : clearTimeout(h as ReturnType<typeof setTimeout>)));
  let handle: unknown = null;
  let lastWritten = store.getState().playheadMs;

  const write = (ms: number) => {
    const v = Math.max(0, ms);
    lastWritten = v;
    if (store.getState().playheadMs !== v) store.getState().setPlayhead(v);
  };
  const syncPlaying = () => {
    const p = clock.playing();
    if (store.getState().playing !== p) store.getState().setPlaying(p);
  };
  const stopLoop = () => {
    if (handle !== null) caf(handle);
    handle = null;
  };
  const startLoop = () => {
    if (handle !== null) return;
    const tick = () => {
      handle = null;
      player.frame();
      if (clock.playing()) handle = raf(tick);
    };
    handle = raf(tick);
  };
  const scrub = (ms: number) => {
    if (!clock.playing() && store.getState().scrubAudio) deps.mixer?.scrub(ms);
  };

  const player: Player = {
    frame() {
      write(clock.update());
      syncPlaying();
      if (!clock.playing()) stopLoop();
    },
    play() {
      clock.play(undefined, 1);
      write(clock.now());
      syncPlaying();
      if (clock.playing()) startLoop();
    },
    pause() {
      clock.pause();
      write(clock.now());
      syncPlaying();
      stopLoop();
    },
    toggle() {
      if (clock.playing()) player.pause();
      else player.play();
    },
    seek(ms) {
      clock.seek(ms);
      const at = clock.now();
      write(at);
      scrub(at);
    },
    setRate(rate) {
      clock.setRate(rate);
    },
    rate: () => clock.rate(),
    reverse() {
      const r = clock.rate();
      const next = clock.playing() && r < 0 ? Math.max(-4, r * 2) : -1;
      clock.play(undefined, next);
      write(clock.now());
      syncPlaying();
      if (clock.playing()) startLoop();
      else stopLoop();
    },
    loop: (range) => clock.setLoop(range),
    playing: () => clock.playing(),
    now: () => clock.now(),
    dispose() {
      stopLoop();
      unsubscribe();
      clock.pause();
    },
  };

  // The store is writable by anyone: a playhead moved from outside (ruler click, marker jump) or `playing` set elsewhere drives the clock.
  const unsubscribe = store.subscribe((s, prev) => {
    if (s.playheadMs !== prev.playheadMs && s.playheadMs !== lastWritten) {
      lastWritten = s.playheadMs;
      clock.seek(s.playheadMs);
      scrub(clock.now());
    }
    if (s.playing !== prev.playing && s.playing !== clock.playing()) {
      if (s.playing) player.play();
      else player.pause();
    }
  });
  return player;
}
