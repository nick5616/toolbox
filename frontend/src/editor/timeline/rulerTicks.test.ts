import { describe, expect, it } from "vitest";
import { MIN_LABEL_PX, majorStepFor, rulerLabel, rulerTicks, subdivisionsFor } from "./rulerTicks";

describe("ruler ticks", () => {
  it("labelled ticks stay at least the minimum apart at every zoom", () => {
    for (const pps of [6, 12, 30, 80, 200, 600, 2000]) {
      const step = majorStepFor(pps, 30);
      expect((step * pps) / 1000).toBeGreaterThanOrEqual(MIN_LABEL_PX);
    }
  });
  it("zooming in goes from minutes to seconds to frames", () => {
    expect(majorStepFor(6, 30)).toBeGreaterThanOrEqual(10_000);
    expect(majorStepFor(80, 30)).toBe(2000);
    expect(majorStepFor(2000, 30)).toBeLessThan(100);
  });
  it("frame steps are whole frames", () => {
    const step = majorStepFor(2000, 30);
    expect(step / (1000 / 30)).toBeCloseTo(Math.round(step / (1000 / 30)), 6);
  });
  it("minor ticks never subdivide below a frame", () => {
    const f = 1000 / 30;
    const step = majorStepFor(1500, 30);
    const d = subdivisionsFor(step, 1500, 30);
    expect(step / d).toBeGreaterThanOrEqual(f - 0.001);
  });
  it("labels: SS:FF under a second, M:SS to a minute, H:MM:SS above", () => {
    expect(rulerLabel(1500, 100, 30)).toBe("1:15");
    expect(rulerLabel(65_000, 100, 30)).toBe("1:05:00");
    expect(rulerLabel(65_000, 1000, 30)).toBe("1:05");
    expect(rulerLabel(3_725_000, 60_000, 30)).toBe("1:02:05");
  });
  it("returns the ticks in the window with labels on the major ones", () => {
    const ticks = rulerTicks(100, 0, 1000, 30);
    expect(ticks.length).toBeGreaterThan(5);
    expect(ticks.every((t) => t.ms >= 0)).toBe(true);
    for (const t of ticks) expect(t.major ? typeof t.label === "string" : t.label === undefined).toBe(true);
    expect(ticks[0]).toMatchObject({ ms: 0, major: true });
    const times = ticks.map((t) => t.ms);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
  it("covers a scrolled window and nothing before 0", () => {
    const ticks = rulerTicks(100, 10_000, 500, 30);
    expect(ticks[0]?.ms).toBeLessThanOrEqual(10_000);
    expect(ticks.at(-1)?.ms).toBeGreaterThanOrEqual(15_000);
    expect(rulerTicks(100, -500, 500, 30)[0]?.ms).toBe(0);
  });
  it("is empty without a width", () => {
    expect(rulerTicks(100, 0, 0, 30)).toEqual([]);
    expect(rulerTicks(0, 0, 100, 30)).toEqual([]);
  });
  it("works at 24 and 60 fps", () => {
    for (const fps of [24, 60]) expect(rulerTicks(1800, 0, 600, fps).length).toBeGreaterThan(5);
  });
});
