import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClock } from "@/editor/audio/clock";
import { emptyEditProject, type NormalProject } from "@/viz/edit/defaults";
import { useEditStudio } from "@/editor/store";
import { createPlayer, usePlayheadCoarse } from "./player";

function setup(length = 10_000) {
  const ctx = { currentTime: 0 };
  const mixer = { start: vi.fn(), stop: vi.fn(), scrub: vi.fn() };
  const clock = createClock({ ctx, mixer, length: () => length });
  const frames: Array<() => void> = [];
  const player = createPlayer({ clock, mixer, raf: (cb) => frames.push(cb), caf: () => undefined });
  const runFrame = () => {
    const cb = frames.shift();
    cb?.();
  };
  return { ctx, mixer, clock, player, frames, runFrame };
}

beforeEach(() => {
  useEditStudio.getState().close();
  useEditStudio.getState().open("p1", "E", emptyEditProject("9:16", 30, 1) as NormalProject);
});

describe("player", () => {
  it("writes the playhead once per frame from the clock", () => {
    const { ctx, player, runFrame, frames } = setup();
    player.play();
    expect(useEditStudio.getState().playing).toBe(true);
    expect(frames).toHaveLength(1);
    ctx.currentTime = 1.5;
    runFrame();
    expect(useEditStudio.getState().playheadMs).toBe(1500);
    expect(frames).toHaveLength(1); // the next frame is queued
    player.dispose();
  });

  it("stops at the end and clears playing", () => {
    const { ctx, player, runFrame, frames } = setup(4000);
    player.play();
    ctx.currentTime = 9;
    runFrame();
    expect(useEditStudio.getState().playheadMs).toBe(4000);
    expect(useEditStudio.getState().playing).toBe(false);
    expect(frames).toHaveLength(0);
    player.dispose();
  });

  it("toggle pauses and plays", () => {
    const { ctx, player } = setup();
    player.toggle();
    ctx.currentTime = 2;
    player.toggle();
    expect(useEditStudio.getState().playing).toBe(false);
    expect(useEditStudio.getState().playheadMs).toBe(2000);
    player.dispose();
  });

  it("reverse doubles −1, −2, −4 and stops there", () => {
    const { player, clock } = setup();
    player.seek(8000);
    const rates: number[] = [];
    for (let i = 0; i < 4; i++) {
      player.reverse();
      rates.push(clock.rate());
    }
    expect(rates).toEqual([-1, -2, -4, -4]);
    expect(useEditStudio.getState().playing).toBe(true);
    player.play(); // back to forward 1×
    expect(clock.rate()).toBe(1);
    player.dispose();
  });

  it("reverse at the start does nothing", () => {
    const { player } = setup();
    player.reverse();
    expect(useEditStudio.getState().playing).toBe(false);
    player.dispose();
  });

  it("a playhead set from outside seeks the clock; its own writes don't", () => {
    const { clock, player, ctx, runFrame, mixer } = setup();
    act(() => useEditStudio.getState().setPlayhead(6000));
    expect(clock.now()).toBe(6000);
    mixer.scrub.mockClear();
    player.play();
    ctx.currentTime = 1;
    runFrame();
    expect(clock.now()).toBe(7000);
    expect(mixer.start).toHaveBeenLastCalledWith(6000, 1); // no seek restart from its own write
    player.dispose();
  });

  it("scrubs a grain when seeking while paused and the setting is on", () => {
    const { player, mixer } = setup();
    player.seek(1234);
    expect(mixer.scrub).toHaveBeenCalledWith(1234);
    useEditStudio.getState().setScrubAudio(false);
    player.seek(2000);
    expect(mixer.scrub).toHaveBeenCalledTimes(1);
    useEditStudio.getState().setScrubAudio(true);
    player.dispose();
  });

  it("playing set in the store starts and stops the clock", () => {
    const { clock, player } = setup();
    act(() => useEditStudio.getState().setPlaying(true));
    expect(clock.playing()).toBe(true);
    act(() => useEditStudio.getState().setPlaying(false));
    expect(clock.playing()).toBe(false);
    player.dispose();
  });

  it("setRate and loop reach the clock", () => {
    const { clock, player } = setup();
    player.setRate(2);
    expect(player.rate()).toBe(2);
    player.play(); // plays at 1×
    expect(clock.rate()).toBe(1);
    player.loop({ inMs: 1000, outMs: 2000 });
    player.dispose();
  });
});

describe("usePlayheadCoarse", () => {
  it("changes only when the step does", () => {
    const { result } = renderHook(() => usePlayheadCoarse(100));
    expect(result.current).toBe(0);
    act(() => useEditStudio.getState().setPlayhead(99));
    expect(result.current).toBe(0);
    act(() => useEditStudio.getState().setPlayhead(250));
    expect(result.current).toBe(200);
  });
});
