import { describe, expect, it } from "vitest";
import { editFrameRange } from "./worker";

describe("editFrameRange (matches core/viz plannedFrames)", () => {
  it("renders the whole edit when the plan covers it", () => {
    expect(editFrameRange({ startMs: 0, endMs: 12000, fps: 30 }, null, 12000)).toEqual({ fromMs: 0, frames: 360 });
  });
  it("an In/Out export without a song starts at the In point", () => {
    expect(editFrameRange({ startMs: 2500, endMs: 7500, fps: 30 }, null, 12000)).toEqual({ fromMs: 2500, frames: 150 });
  });
  it("with a song the plan is in song ms, so the song's start is taken off", () => {
    expect(editFrameRange({ startMs: 41000 + 3000, endMs: 41000 + 9000, fps: 25 }, 41000, 30000)).toEqual({ fromMs: 3000, frames: 150 });
  });
  it("falls back to the compiled length without a range", () => {
    expect(editFrameRange({ startMs: 0, endMs: 0, fps: 30 }, null, 1000)).toEqual({ fromMs: 0, frames: 30 });
  });
});
