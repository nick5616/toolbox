/**
 * The editor's audio engine: one AudioContext, the mixer and the clock built
 * on it (Phase 21 SPEC §B1). The Transport creates it while the editor is
 * open; `useAudioSourceState` / `useAudioLoading` let the timeline show
 * "loading audio" dots.
 */
import { useSyncExternalStore } from "react";
import { createClock, type Clock } from "./clock";
import { createMixer, type MixerImpl } from "./mixer";
import type { AudioSourceState } from "./types";

export interface AudioEngine {
  clock: Clock;
  /** null where there is no Web Audio (the clock then runs on wall time and nothing makes sound). */
  mixer: MixerImpl | null;
  dispose(): void;
}

export interface AudioEngineDeps {
  length(): number;
  resolve(path: string): string | null;
  onEnd?(): void;
}

let current: AudioEngine | null = null;
let version = 0;
const listeners = new Set<() => void>();
const bump = () => {
  version++;
  for (const l of listeners) l();
};
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

export function createAudioEngine(deps: AudioEngineDeps): AudioEngine {
  const Ctor = typeof AudioContext === "undefined" ? null : AudioContext;
  const ctx = Ctor ? new Ctor() : null;
  const mixer = ctx ? createMixer({ ctx, resolve: deps.resolve, onState: bump }) : null;
  const clock = createClock({
    ctx: ctx ?? { get currentTime() { return performance.now() / 1000; } },
    mixer,
    length: deps.length,
    onEnd: deps.onEnd,
  });
  const engine: AudioEngine = {
    clock,
    mixer,
    dispose() {
      mixer?.dispose();
      void ctx?.close().catch(() => undefined);
      if (current === engine) {
        current = null;
        bump();
      }
    },
  };
  current = engine;
  bump();
  return engine;
}

/** The running engine, if the editor is open. */
export function getAudioEngine(): AudioEngine | null {
  return current;
}

/** A source file's audio state ("loading audio" dots); "none" without an engine. */
export function useAudioSourceState(path: string): AudioSourceState {
  return useSyncExternalStore(subscribe, () => (version >= 0 ? (current?.mixer?.state(path) ?? "none") : "none"));
}

/** Whether any audio is still decoding. */
export function useAudioLoading(): boolean {
  return useSyncExternalStore(subscribe, () => (current?.mixer?.loading() ?? 0) > 0);
}
