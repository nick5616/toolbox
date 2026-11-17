import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * The designer's playhead as a tiny external store: the player ticks ~30 times a
 * second and only the components that draw the time (preview canvas, Song Map)
 * subscribe, so the rest of the designer does not re-render on every tick.
 */
export interface PlayheadStore {
  get(): number;
  set(ms: number): void;
  subscribe(fn: () => void): () => void;
}

export function createPlayheadStore(initial = 0): PlayheadStore {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(ms) {
      if (ms === value) return;
      value = ms;
      for (const fn of [...subs]) fn();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

/** The current playhead; re-renders on every change. */
export function usePlayhead(store: PlayheadStore): number {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** The playhead, but state changes at most once per `ms` (trailing edge kept): for live readouts. */
export function useThrottledPlayhead(store: PlayheadStore, ms: number): number {
  const [out, setOut] = useState(store.get());
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    timer.current = null;
    last.current = Date.now();
    setOut(store.get());
  }, [store]);
  useEffect(() => {
    const on = () => {
      if (timer.current) return; // the trailing update reads the latest value
      const wait = Math.max(0, last.current + ms - Date.now());
      if (wait === 0) flush();
      else timer.current = setTimeout(flush, wait);
    };
    on(); // pick up a change since render
    const off = store.subscribe(on);
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [store, ms, flush]);
  return out;
}

/** Poll periods for a host player that has no time callback. */
export const POLL_PLAYING_MS = 33;
export const POLL_IDLE_MS = 100;

/**
 * Follows a player that has no time callback. Polls every 33 ms while it plays and
 * only every 100 ms otherwise (enough to notice a play or an outside seek).
 */
export function followPlayer(player: { currentMs(): number; playing(): boolean }, store: PlayheadStore): () => void {
  let stopped = false;
  let t: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    if (stopped) return;
    store.set(player.currentMs());
    t = setTimeout(tick, player.playing() ? POLL_PLAYING_MS : POLL_IDLE_MS);
  };
  tick();
  return () => {
    stopped = true;
    if (t) clearTimeout(t);
  };
}
