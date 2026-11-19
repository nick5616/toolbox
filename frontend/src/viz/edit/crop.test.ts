import { describe, expect, it } from "vitest";
import { cropCoverage, cropRect, evalTransform } from "./clip";
import { CROP_RULES, parseTransform, serializeTransform } from "./schema";
import type { ClipTransform } from "./types";

const base: ClipTransform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };

describe("crop (Phase 21 §B4)", () => {
  it("no crop evaluates to zeros", () => {
    expect(evalTransform(base, 540, 960, 0, 0, null).crop).toEqual([0, 0, 0, 0]);
  });
  it("evaluates each edge, clamped to 0..0.45", () => {
    const t: ClipTransform = { ...base, crop: { l: 0.1, r: 0.2, t: 0.9, b: 0 } };
    expect(evalTransform(t, 540, 960, 0, 0, null).crop).toEqual([0.1, 0.2, CROP_RULES.max, 0]);
  });
  it("keys animate a crop edge", () => {
    const t: ClipTransform = { ...base, crop: { l: { base: 0, keys: [{ t: 0, v: 0, ease: "linear" }, { t: 1000, v: 0.4, ease: "linear" }] }, r: 0, t: 0, b: 0 } };
    expect(evalTransform(t, 100, 100, 500, 0, null).crop[0]).toBeCloseTo(0.2, 9);
  });
  it("the kept rectangle in picture UV", () => {
    expect(cropRect([0.1, 0.2, 0.3, 0.05])).toEqual({ u0: 0.1, v0: 0.3, u1: 0.8, v1: 0.95 });
  });
  it("coverage is 1 inside, 0 outside, and 1 everywhere with no crop", () => {
    const crop = [0.25, 0.25, 0, 0] as const;
    const img = [1000, 1000] as const;
    expect(cropCoverage([0.5, 0.5], crop, img, 1)).toBe(1);
    expect(cropCoverage([0.1, 0.5], crop, img, 1)).toBe(0);
    expect(cropCoverage([0.95, 0.5], crop, img, 1)).toBe(0);
    expect(cropCoverage([0.05, 0.5], [0, 0, 0, 0], img, 1)).toBe(1);
    expect(cropCoverage([0.5, 0.01], crop, img, 1)).toBe(1);
  });
  it("coverage antialiases across one output pixel at the edge", () => {
    const crop = [0.25, 0, 0, 0] as const;
    expect(cropCoverage([0.25, 0.5], crop, [1000, 1000], 1)).toBeCloseTo(0.5, 9);
    expect(cropCoverage([0.2505, 0.5], crop, [1000, 1000], 1)).toBeCloseTo(1, 9);
    // scaled down, the edge band is narrower in picture UV
    expect(cropCoverage([0.2502, 0.5], crop, [1000, 1000], 0.5)).toBeCloseTo(0.6, 9);
  });
  it("round-trips through the document", () => {
    const t: ClipTransform = { ...base, crop: { l: 0.1, r: 0, t: 0, b: 0.2 } };
    const back = parseTransform(serializeTransform(t));
    expect(back.problems).toEqual([]);
    expect(back.value.crop).toEqual({ l: 0.1, r: 0, t: 0, b: 0.2 });
  });
});
