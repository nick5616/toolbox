import { describe, expect, it } from "vitest";
import { MOTION_H, MOTION_W, dominantHue, flashTransitions, frameFrom, hueOf, maxFlashesInWindow, measureMotion, toMotionFrame } from "./motion";

const FPS = 60;
const seq = (n: number, f: (k: number) => number, hue?: (k: number) => number) =>
  Array.from({ length: n }, (_, k) => frameFrom(() => f(k), hue ? () => hue(k) : undefined));

describe("measureMotion", () => {
  it("a 5 Hz full-frame strobe is at least 5 flashes per second", () => {
    const frames = seq(180, (k) => (Math.floor(k / 6) % 2 === 0 ? 0.05 : 0.6));
    expect(measureMotion(frames, FPS).flashMaxPerSec).toBeGreaterThanOrEqual(5);
  });

  it("a 2 Hz strobe stays within the WCAG limit", () => {
    const frames = seq(180, (k) => (Math.floor(k / 15) % 2 === 0 ? 0.05 : 0.6));
    expect(measureMotion(frames, FPS).flashMaxPerSec).toBeLessThanOrEqual(3);
  });

  it("a slow fade has no flashes, no teleports and little change", () => {
    const m = measureMotion(seq(240, (k) => k / 239), FPS);
    expect(m.flashMaxPerSec).toBe(0);
    expect(m.teleports).toBe(0);
    expect(m.meanDelta).toBeLessThan(0.01);
  });

  it("a strobe between bright states is not a flash (darker >= 0.8)", () => {
    expect(measureMotion(seq(120, (k) => (k % 2 ? 0.85 : 0.97)), FPS).flashMaxPerSec).toBe(0);
  });

  it("a flash in one grid cell only is found", () => {
    const frames = Array.from({ length: 120 }, (_, k) =>
      frameFrom((i) => {
        const x = i % MOTION_W;
        const y = Math.floor(i / MOTION_W);
        const inCell = x < MOTION_W / 4 && y < MOTION_H / 4;
        return inCell && Math.floor(k / 5) % 2 === 0 ? 0.7 : 0.1;
      }),
    );
    expect(measureMotion(frames, FPS).flashMaxPerSec).toBeGreaterThanOrEqual(5);
  });

  it("a hard cut is one teleport, unless it is inside a transition", () => {
    const a = (i: number) => (i % MOTION_W) / MOTION_W;
    const b = (i: number) => 1 - (i % MOTION_W) / MOTION_W;
    const frames = Array.from({ length: 20 }, (_, k) => frameFrom(k < 10 ? a : b));
    expect(measureMotion(frames, FPS).teleports).toBe(1);
    (frames[10] as { inTransition: boolean }).inTransition = true;
    expect(measureMotion(frames, FPS).teleports).toBe(0);
  });

  it("hue rotating at 90 deg/s reads about 90", () => {
    const m = measureMotion(seq(120, () => 0.3, (k) => (k * 1.5) % 360), FPS);
    expect(m.hueChurn).toBeGreaterThan(85);
    expect(m.hueChurn).toBeLessThan(95);
  });

  it("hue wraps the short way and grey frames have no hue", () => {
    expect(measureMotion(seq(10, () => 0.3, (k) => (k % 2 ? 355 : 5)), FPS).hueChurn).toBeCloseTo(10 * FPS, 3);
    expect(measureMotion(seq(10, () => 0.3), FPS).hueChurn).toBe(0);
  });

  it("static frames are all zeros", () => {
    expect(measureMotion(seq(30, () => 0.4), FPS)).toEqual({ flashMaxPerSec: 0, meanDelta: 0, p95Delta: 0, teleports: 0, hueChurn: 0, busyness: 0 });
  });

  it("busyness and deltas grow with motion", () => {
    const calm = measureMotion(seq(60, (k) => 0.4 + 0.001 * (k % 2)), FPS);
    const wild = measureMotion(seq(60, (k) => 0.2 + 0.3 * (k % 2)), FPS);
    expect(wild.busyness).toBeGreaterThan(calm.busyness);
    expect(wild.meanDelta).toBeCloseTo(0.3, 2);
    expect(wild.p95Delta).toBeGreaterThan(0.25);
  });

  it("fewer than two frames measure as zero", () => {
    expect(measureMotion([], FPS).meanDelta).toBe(0);
  });
});

describe("flash helpers", () => {
  it("zigzag ignores wiggles under 0.10", () => {
    expect(flashTransitions([0, 0.05, 0, 0.05, 0.02])).toEqual([]);
  });
  it("counts pairs per window", () => {
    expect(maxFlashesInWindow([0, 6, 12, 18, 24, 30], 60)).toBe(3);
    expect(maxFlashesInWindow([0, 100], 60)).toBe(0);
  });
});

describe("toMotionFrame", () => {
  const solid = (w: number, h: number, r: number, g: number, b: number) => {
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) px.set([r, g, b, 255], i * 4);
    return px;
  };
  it("downsamples to 64 x 36 with linear luminance", () => {
    const f = toMotionFrame(solid(640, 360, 255, 255, 255), 640, 360);
    expect([f.w, f.h, f.lum.length]).toEqual([64, 36, 2304]);
    expect(f.lum[0]).toBeCloseTo(1, 4);
    expect(Number.isNaN(f.hue[0] as number)).toBe(true);
    expect(toMotionFrame(solid(640, 360, 128, 128, 128), 640, 360).lum[100]).toBeCloseTo(0.2158, 3);
  });
  it("handles sizes that do not divide evenly and reads hue", () => {
    const f = toMotionFrame(solid(100, 50, 255, 0, 0), 100, 50);
    expect(f.hue[5]).toBeCloseTo(0, 3);
    expect(f.lum[5]).toBeCloseTo(0.2126, 3);
    expect(hueOf(0, 1, 0)).toBeCloseTo(120, 5);
    expect(dominantHue(f.hue)).toBeCloseTo(0, 3);
  });
});
