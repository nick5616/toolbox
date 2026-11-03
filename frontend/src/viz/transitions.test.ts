import { describe, expect, it } from "vitest";
import { TRANSITION_KINDS } from "./edit/schema";
import { transitionSource } from "./transitions";
import {
  blurRadius,
  envelope,
  flashBlackGainA,
  flashBlackGainB,
  irisMaxRadius,
  irisReveal,
  lumaReveal,
  rgbSplitOffset,
  shakeOffset,
  slideOffset,
  slideSample,
  spinAngle,
  spinBlur,
  stripesReveal,
  swap,
  triangle,
  warpAmount,
  whipBlur,
  whipShift,
  zoomOutBlur,
  zoomOutScaleA,
  zoomOutScaleB,
  zoomOutWeight,
} from "./transitionsMath";

const STEPS = Array.from({ length: 101 }, (_, i) => i / 100);

describe("transition sources", () => {
  it("every kind but cut has its own shader", () => {
    for (const k of TRANSITION_KINDS) {
      if (k === "cut") continue;
      const src = transitionSource(k);
      expect(src, k).toBeTruthy();
      expect(src).toContain("void main");
      expect(src).not.toContain("random");
    }
  });
});

describe("envelopes vanish at the ends", () => {
  it("is exactly zero at mix 0 and 1 (or within float noise of sin(pi))", () => {
    expect(envelope(0)).toBe(0);
    expect(Math.abs(envelope(1))).toBeLessThan(1e-15);
    expect(envelope(0.5)).toBe(1);
    expect(triangle(0)).toBe(0);
    expect(triangle(1)).toBe(0);
    expect(triangle(0.5)).toBe(1);
  });
  it("effect strengths are zero at the ends", () => {
    for (const f of [zoomOutBlur, spinBlur, whipBlur, rgbSplitOffset, blurRadius, warpAmount]) {
      expect(f(0)).toBe(0);
      expect(Math.abs(f(1))).toBeLessThan(1e-15);
    }
    expect(whipShift(0)).toBe(0);
    expect(whipShift(1)).toBe(0);
    expect(shakeOffset(1234, 0)).toEqual([0, 0]);
    const [x, y] = shakeOffset(1234, 1);
    expect(Math.abs(x) + Math.abs(y)).toBeLessThan(1e-15);
  });
});

describe("swap kinds show a then b", () => {
  it("steps at 0.5", () => {
    expect(swap(0)).toBe(0);
    expect(swap(0.49)).toBe(0);
    expect(swap(0.5)).toBe(1);
    expect(swap(1)).toBe(1);
  });
  it("spin lands upright at both ends", () => {
    expect(spinAngle(0)).toBe(0);
    expect(Math.abs(spinAngle(1))).toBeLessThan(1e-12);
    expect(spinAngle(0.25)).toBeGreaterThan(0);
    expect(spinAngle(0.75)).toBeLessThan(0);
  });
  it("whip pans a away then b in", () => {
    expect(whipShift(0.25)).toBeGreaterThan(0);
    expect(whipShift(0.75)).toBeLessThan(0);
  });
  it("shake is deterministic and changes per 33 ms step", () => {
    expect(shakeOffset(500, 0.5)).toEqual(shakeOffset(510, 0.5));
    expect(shakeOffset(500, 0.5)).not.toEqual(shakeOffset(700, 0.5));
    expect(shakeOffset(500, 0.5)).toEqual(shakeOffset(500, 0.5));
  });
});

describe("zoomout", () => {
  it("is the identity on a at 0 and on b at 1", () => {
    expect(zoomOutScaleA(0)).toBe(1);
    expect(zoomOutScaleB(1)).toBe(1);
    expect(zoomOutScaleB(0)).toBeCloseTo(1.3);
    expect(zoomOutWeight(0)).toBe(0);
    expect(zoomOutWeight(1)).toBe(1);
  });
  it("weight is monotonic", () => {
    let prev = -1;
    for (const m of STEPS) {
      const w = zoomOutWeight(m);
      expect(w).toBeGreaterThanOrEqual(prev);
      prev = w;
    }
  });
});

describe("slide", () => {
  it("shows only a at 0 and only b at 1", () => {
    for (const x of [0, 0.3, 0.999]) {
      expect(slideSample(x, 0)).toEqual({ from: 0, x });
      expect(slideSample(x, 1).from).toBe(1);
      expect(slideSample(x, 1).x).toBeCloseTo(x, 12);
    }
    expect(slideOffset(0)).toBe(0);
    expect(slideOffset(1)).toBe(1);
  });
});

describe("luma", () => {
  it("is all a at 0 and all b at 1 for any luma", () => {
    for (const l of [0, 0.2, 0.5, 0.99, 1, 7]) {
      expect(lumaReveal(l, 0)).toBe(0);
      expect(lumaReveal(l, 1)).toBe(1);
    }
  });
  it("reveals dark parts first and never un-reveals", () => {
    for (const m of STEPS) expect(lumaReveal(0.2, m)).toBeGreaterThanOrEqual(lumaReveal(0.8, m));
    for (const l of [0, 0.5, 1]) {
      let prev = -1;
      for (const m of STEPS) {
        const w = lumaReveal(l, m);
        expect(w).toBeGreaterThanOrEqual(prev);
        prev = w;
      }
    }
  });
});

describe("iris", () => {
  const aspect = 16 / 9;
  it("is empty at 0 (even at the centre) and complete at 1 (even in the corner)", () => {
    expect(irisReveal(0, 0, aspect)).toBe(0);
    expect(irisReveal(0.3, 0, aspect)).toBe(0);
    expect(irisReveal(irisMaxRadius(aspect), 1, aspect)).toBe(1);
    expect(irisReveal(0, 1, aspect)).toBe(1);
  });
  it("grows with mix and shrinks with distance", () => {
    for (const d of [0, 0.2, 0.6, irisMaxRadius(aspect)]) {
      let prev = -1;
      for (const m of STEPS) {
        const w = irisReveal(d, m, aspect);
        expect(w).toBeGreaterThanOrEqual(prev);
        prev = w;
      }
    }
    expect(irisReveal(0.1, 0.5, aspect)).toBeGreaterThanOrEqual(irisReveal(0.5, 0.5, aspect));
  });
});

describe("stripes", () => {
  it("is empty at 0 and complete at 1 everywhere", () => {
    for (let i = 0; i <= 40; i++) {
      for (let j = 0; j <= 10; j++) {
        const x = i / 40;
        const y = j / 10;
        expect(stripesReveal(x, y, 16 / 9, 0)).toBe(0);
        expect(stripesReveal(x, y, 16 / 9, 1)).toBe(1);
      }
    }
  });
  it("is monotonic in mix", () => {
    for (const [x, y] of [[0.1, 0.2], [0.55, 0.9], [0.9, 0.05]] as const) {
      let prev = -1;
      for (const m of STEPS) {
        const w = stripesReveal(x, y, 1.5, m);
        expect(w).toBeGreaterThanOrEqual(prev);
        prev = w;
      }
    }
  });
});

describe("flashblack", () => {
  it("a at full gain at 0, black at 0.5, b at full gain at 1", () => {
    expect(flashBlackGainA(0)).toBe(1);
    expect(flashBlackGainA(0.5)).toBe(0);
    expect(flashBlackGainB(0.5)).toBe(0);
    expect(flashBlackGainB(1)).toBe(1);
    expect(flashBlackGainB(0)).toBe(0);
  });
  it("a only fades out, b only fades in", () => {
    for (let i = 1; i < STEPS.length; i++) {
      const m0 = STEPS[i - 1]!;
      const m1 = STEPS[i]!;
      expect(flashBlackGainA(m1)).toBeLessThanOrEqual(flashBlackGainA(m0));
      expect(flashBlackGainB(m1)).toBeGreaterThanOrEqual(flashBlackGainB(m0));
    }
  });
});
