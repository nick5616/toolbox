import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlayheadStore, followPlayer, POLL_IDLE_MS, POLL_PLAYING_MS } from "./playhead";

describe("playhead store", () => {
  it("notifies only on change and unsubscribes", () => {
    const s = createPlayheadStore(5);
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.set(5);
    expect(fn).not.toHaveBeenCalled();
    s.set(7);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(s.get()).toBe(7);
    off();
    s.set(9);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("followPlayer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("polls fast while playing and slowly when idle, and stops", () => {
    let ms = 0;
    let playing = true;
    const reads = vi.fn(() => ms);
    const store = createPlayheadStore(-1);
    const stop = followPlayer({ currentMs: reads, playing: () => playing }, store);
    expect(store.get()).toBe(0);
    ms = 40;
    vi.advanceTimersByTime(POLL_PLAYING_MS);
    expect(store.get()).toBe(40);
    playing = false;
    vi.advanceTimersByTime(POLL_PLAYING_MS); // reads once more, then goes idle
    const n = reads.mock.calls.length;
    vi.advanceTimersByTime(POLL_IDLE_MS * 3);
    expect(reads.mock.calls.length - n).toBeLessThanOrEqual(3);
    stop();
    const m = reads.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(reads.mock.calls.length).toBe(m);
  });
});
