import { describe, expect, it } from "vitest";
import { MAX_PPS, MIN_PPS, ZOOM_STEP, fitPps, fitView, maxScrollMs, msToX, panBy, ppsToSlider, sliderToPps, xToMs, zoomAround } from "./geometry";

describe("zoom math", () => {
  const view = { pps: 100, scrollMs: 2000 };

  it("keeps the anchor moment under the same pixel", () => {
    const anchor = 5000;
    const before = msToX(anchor, view.pps, view.scrollMs);
    const next = zoomAround(view, ZOOM_STEP, anchor, 800, 600_000);
    expect(next.pps).toBeCloseTo(150, 6);
    expect(msToX(anchor, next.pps, next.scrollMs)).toBeCloseTo(before, 6);
  });
  it("zooming out keeps it too (until the left edge hits 0)", () => {
    const next = zoomAround({ pps: 100, scrollMs: 20_000 }, 1 / ZOOM_STEP, 25_000, 800, 600_000);
    expect(msToX(25_000, next.pps, next.scrollMs)).toBeCloseTo(msToX(25_000, 100, 20_000), 6);
  });
  it("never leaves 6–2000 px/s", () => {
    expect(zoomAround({ pps: 1900, scrollMs: 0 }, 5, 0, 800, 600_000).pps).toBe(MAX_PPS);
    expect(zoomAround({ pps: 7, scrollMs: 0 }, 0.01, 0, 800, 6_000_000).pps).toBe(MIN_PPS);
  });
  it("never zooms further out than the whole edit", () => {
    // 10 s in 1000 px fits at 100 px/s: zooming out from there stays put.
    expect(zoomAround({ pps: 100, scrollMs: 0 }, 0.5, 0, 1000, 10_000).pps).toBeCloseTo(100, 6);
    expect(zoomAround({ pps: 400, scrollMs: 0 }, 0.1, 0, 1000, 10_000).pps).toBeCloseTo(100, 6);
  });
  it("the scroll never goes negative or past the end", () => {
    expect(zoomAround({ pps: 100, scrollMs: 0 }, 2, 0, 800, 600_000).scrollMs).toBe(0);
    const end = zoomAround({ pps: 100, scrollMs: 590_000 }, 2, 599_000, 800, 600_000);
    expect(end.scrollMs).toBeLessThanOrEqual(maxScrollMs(600_000, 800, end.pps));
  });
  it("fit puts the whole edit in view with a little room", () => {
    const v = fitView(10_000, 1000);
    expect(v.scrollMs).toBe(0);
    expect(v.pps).toBeCloseTo(fitPps(10_200, 1000), 6);
    expect((10_000 * v.pps) / 1000).toBeLessThan(1000);
  });
  it("fit respects the range", () => {
    expect(fitPps(1, 1000)).toBe(MAX_PPS);
    expect(fitPps(10_000_000, 100)).toBe(MIN_PPS);
  });
  it("pans within the edit", () => {
    expect(panBy({ pps: 100, scrollMs: 0 }, -50, 800, 60_000).scrollMs).toBe(0);
    expect(panBy({ pps: 100, scrollMs: 1000 }, 100, 800, 60_000).scrollMs).toBe(2000);
    expect(panBy({ pps: 100, scrollMs: 51_900 }, 1000, 800, 60_000).scrollMs).toBe(52_000);
  });
  it("the slider maps 0..1000 to the range logarithmically and back", () => {
    expect(sliderToPps(0)).toBeCloseTo(MIN_PPS, 6);
    expect(sliderToPps(1000)).toBeCloseTo(MAX_PPS, 6);
    for (const pps of [6, 20, 80, 400, 2000]) expect(sliderToPps(ppsToSlider(pps))).toBeCloseTo(pps, 0);
    // Equal steps are equal factors.
    expect(sliderToPps(600) / sliderToPps(500)).toBeCloseTo(sliderToPps(300) / sliderToPps(200), 6);
  });
  it("a frame is several pixels wide at the top zoom (60 fps)", () => {
    expect((2000 * 1000) / 60 / 1000).toBeGreaterThan(30);
  });
  it("msToX and xToMs are inverses", () => {
    expect(xToMs(msToX(1234, 80, 500), 80, 500)).toBeCloseTo(1234, 6);
  });
});
