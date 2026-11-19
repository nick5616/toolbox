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
