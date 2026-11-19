import { describe, expect, it } from "vitest";
import { cubicBezier, easeIn, easeInOut, easeOut, evalEditParam, interpolateKeys } from "./params";
import type { Key } from "./types";

describe("easing (Phase 21 §B3)", () => {
  const k = (t: number, v: number, ease: Key["ease"], bez?: Key["bez"]): Key => (bez ? { t, v, ease, bez } : { t, v, ease });
  it("cubic in, out and in-out goldens", () => {
    expect(easeIn(0.5)).toBeCloseTo(0.125, 9);
    expect(easeOut(0.5)).toBeCloseTo(0.875, 9);
    expect(easeInOut(0.25)).toBeCloseTo(0.0625, 9);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 9);
    expect(easeInOut(0.75)).toBeCloseTo(0.9375, 9);
    expect(interpolateKeys([k(0, 0, "in"), k(100, 10, "linear")], 50)).toBeCloseTo(1.25, 9);
    expect(interpolateKeys([k(0, 0, "out"), k(100, 10, "linear")], 50)).toBeCloseTo(8.75, 9);
    expect(interpolateKeys([k(0, 0, "inout"), k(100, 10, "linear")], 25)).toBeCloseTo(0.625, 9);
  });
  it("bezier matches the CSS keyword curves", () => {
    for (const x of [0, 0.1, 0.5, 0.9, 1]) expect(cubicBezier(0, 0, 1, 1, x)).toBeCloseTo(x, 6);
    expect(cubicBezier(0.42, 0, 0.58, 1, 0.5)).toBeCloseTo(0.5, 6);
    expect(cubicBezier(0.25, 0.1, 0.25, 1, 0.5)).toBeCloseTo(0.8024, 3);
    expect(cubicBezier(0.42, 0, 1, 1, 0.5)).toBeLessThan(0.5);
    expect(cubicBezier(0, 0, 0.58, 1, 0.5)).toBeGreaterThan(0.5);
  });
  it("bezier is monotone in x, hits the ends and may overshoot", () => {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const y = cubicBezier(0.3, 0.2, 0.7, 0.9, i / 100);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = y;
    }
    expect(cubicBezier(0.2, -1, 0.8, 2, 0)).toBe(0);
    expect(cubicBezier(0.2, -1, 0.8, 2, 1)).toBe(1);
    expect(cubicBezier(0.3, 1.8, 0.7, 1, 0.3)).toBeGreaterThan(1);
  });
  it("the bisection fallback copes with flat slopes", () => {
    expect(cubicBezier(0, 0, 1, 1, 0.001)).toBeCloseTo(0.001, 4);
    expect(Number.isFinite(cubicBezier(1, 0, 0, 1, 0.5))).toBe(true);
    expect(cubicBezier(1, 0, 0, 1, 0.5)).toBeCloseTo(0.5, 4);
  });
  it("a bezier key evaluates through interpolateKeys and falls back to smooth without bez", () => {
    expect(interpolateKeys([k(0, 0, "bezier", [0.42, 0, 0.58, 1]), k(100, 10, "linear")], 50)).toBeCloseTo(5, 5);
    expect(interpolateKeys([k(0, 0, "bezier"), k(100, 10, "linear")], 25)).toBeCloseTo(10 * (0.25 * 0.25 * 2.5), 9);
    expect(evalEditParam({ base: 0, keys: [k(0, 0, "bezier", [0.3, 1.8, 0.7, 1]), k(100, 1, "linear")] }, 0, 1, 30, 0, null)).toBe(1);
  });
});
