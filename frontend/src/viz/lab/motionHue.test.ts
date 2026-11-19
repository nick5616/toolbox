import { describe, expect, it } from "vitest";
import { MOTION_H, MOTION_W, dominantHue, frameFrom, measureMotion } from "./motion";

const N = MOTION_W * MOTION_H;

describe("dominant hue is weighted by what the eye sees", () => {
  it("a dim tinted background doesn't win over a bright colour", () => {
    // 90% of the pixels are a barely-lit blue (hue 240, lum 0.001..0.01), 10% a bright red
    const hue = new Float32Array(N);
    const lum = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const red = i % 10 === 0;
      hue[i] = red ? 0 : 240;
      lum[i] = red ? 0.4 : 0.006;
    }
    expect(dominantHue(hue)).toBeCloseTo(240, 0); // by count: the blue background
    const w = dominantHue(hue, lum);
    expect(Math.min(w, 360 - w)).toBeLessThan(1); // by light: the red
  });

  it("near-black pixels carry no vote, so a flickering tint reads as no churn", () => {
    const a = frameFrom(() => 0.001, (i) => (i % 2 === 0 ? 20 : 200));
    const b = frameFrom(() => 0.001, (i) => (i % 2 === 0 ? 200 : 20));
    expect(Number.isNaN(dominantHue(a.hue, a.lum))).toBe(true);
    const frames = [a, b, a, b, a, b];
    expect(measureMotion(frames, 60).hueChurn).toBe(0);
  });
});

describe("smoothed hue churn", () => {
  it("a colour that flips every frame between two hues is not a colour change when smoothed", () => {
    const frames = Array.from({ length: 120 }, (_, k) => frameFrom(() => 0.3, () => (k % 2 ? 330 : 190)));
    expect(measureMotion(frames, 60).hueChurn).toBeGreaterThan(5000); // raw: 140 degrees per frame
    expect(measureMotion(frames, 60, { hueSmoothSec: 0.5 }).hueChurn).toBeLessThan(30);
  });

  it("a steady rotation still reads its rate when smoothed", () => {
    const frames = Array.from({ length: 480 }, (_, k) => frameFrom(() => 0.3, () => (k / 3) % 360)); // 20 degrees per second at 60 fps
    const churn = measureMotion(frames, 60, { hueSmoothSec: 0.5 }).hueChurn;
    expect(churn).toBeGreaterThan(14);
    expect(churn).toBeLessThan(26);
  });
});
