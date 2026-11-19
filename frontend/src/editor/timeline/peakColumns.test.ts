import { describe, expect, it } from "vitest";
import { newClip } from "@/editor/doc";
import type { Peaks } from "@/editor/audio/types";
import { MAX_COLUMNS, peakColumns, visibleSourceRange } from "./peakColumns";
import { CLIP_INSET_PX, lanePx, nearestHeight, rowPx } from "./trackHeights";

/** 1 s at 100 Hz: a ramp up in the first half, silence after. */
function peaks(): Peaks {
  const n = 100;
  const min = new Int8Array(n);
  const max = new Int8Array(n);
  for (let i = 0; i < 50; i++) {
    max[i] = i * 2;
    min[i] = -i * 2;
  }
  return { rate: 100, channels: 1, min, max, durationMs: 1000 };
}

describe("peak columns", () => {
  it("reduces to the requested number of columns, scaled −1..1", () => {
    const c = peakColumns(peaks(), 0, 1000, 10);
    expect(c.max).toHaveLength(10);
    expect(c.max[0] as number).toBeLessThan(c.max[4] as number);
    expect(c.max[4] as number).toBeLessThanOrEqual(1);
    expect(c.min[4] as number).toBeCloseTo(-(c.max[4] as number), 6);
  });
  it("takes the extremes inside each column", () => {
    const c = peakColumns(peaks(), 0, 500, 1);
    expect(c.max[0]).toBeCloseTo(98 / 127, 6);
  });
  it("is silent after the file's end and before 0", () => {
    const c = peakColumns(peaks(), 800, 2000, 4);
    expect(Array.from(c.max)).toEqual([0, 0, 0, 0]);
    expect(Array.from(peakColumns(peaks(), -500, 0, 2).max)).toEqual([0, 0]);
  });
  it("caps the columns and survives empty ranges", () => {
    expect(peakColumns(peaks(), 0, 1000, 99_999).max).toHaveLength(MAX_COLUMNS);
    expect(peakColumns(peaks(), 100, 100, 5).max).toHaveLength(5);
    expect(peakColumns(peaks(), 0, 1000, 0).max).toHaveLength(0);
  });
  it("maps a clip's visible pixels to its source range (in-point and speed)", () => {
    const c = newClip({ kind: "video", path: "/a.mp4", startMs: 5000, endMs: 9000, inMs: 2000 });
    expect(visibleSourceRange(c, 30, 100, 0, 200)).toEqual({ fromMs: 2000, toMs: 4000 });
    const fast = newClip({ kind: "video", path: "/a.mp4", startMs: 0, endMs: 4000, inMs: 0, speed: "2" });
    const r = visibleSourceRange(fast, 30, 100, 0, 100);
    expect(r.toMs).toBeCloseTo(2000, 0);
  });
});

describe("track heights", () => {
  it("each kind has S < M < L, and thin forces small", () => {
    for (const kind of ["video", "audio", "adjust"]) {
      expect(rowPx(kind, "s")).toBeLessThan(rowPx(kind, "m"));
      expect(rowPx(kind, "m")).toBeLessThan(rowPx(kind, "l"));
      expect(rowPx(kind, "l", true)).toBe(rowPx(kind, "s"));
    }
  });
  it("lanes sit inside the row", () => {
    expect(lanePx(56)).toBe(56 - CLIP_INSET_PX);
  });
  it("a dragged height snaps to the nearest size", () => {
    expect(nearestHeight("video", 20)).toBe("s");
    expect(nearestHeight("video", 60)).toBe("m");
    expect(nearestHeight("video", 200)).toBe("l");
    expect(nearestHeight("audio", rowPx("audio", "l"))).toBe("l");
  });
});
