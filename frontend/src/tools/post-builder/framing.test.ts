import { describe, expect, it } from "vitest";
import { aspectRatio, clampZoom, cropWindow, framedLayout, frameSize, normalizeRotation, panFromDrag } from "./framing";

// Cases copied from TestCropWindow in modules/posts/posts_test.go.
const cases: [string, number, number, number, number, number, number, number, number, number, number][] = [
  ["landscape to 4:5 centred", 4000, 3000, 0.8, 1, 0, 0, 800, 0, 2400, 3000],
  ["landscape to 4:5 pan left", 4000, 3000, 0.8, 1, -1, 0, 0, 0, 2400, 3000],
  ["landscape to 4:5 pan right", 4000, 3000, 0.8, 1, 1, 0, 1600, 0, 2400, 3000],
  ["portrait to 1:1", 3000, 4000, 1, 1, 0, 1, 0, 1000, 3000, 3000],
  ["zoom 2 centred", 4000, 3000, 0.8, 2, 0, 0, 1400, 750, 1200, 1500],
  ["same aspect no crop", 1080, 1350, 0.8, 1, 0.7, -0.4, 0, 0, 1080, 1350],
  ["pan clamps", 4000, 3000, 0.8, 1, 5, -5, 1600, 0, 2400, 3000],
  ["wide frame 1.91", 3000, 3000, 1080 / 566, 1, 0, 0, 0, 714.5, 3000, 1572],
];

describe("cropWindow (mirrors frame.go)", () => {
  it.each(cases)("%s", (_n, w, h, aspect, zoom, panX, panY, wx, wy, ww, wh) => {
    const c = cropWindow(w, h, aspect, zoom, panX, panY);
    expect(Math.abs(c.x - wx)).toBeLessThan(1.5);
    expect(Math.abs(c.y - wy)).toBeLessThan(1.5);
    expect(Math.abs(c.w - ww)).toBeLessThan(1.5);
    expect(Math.abs(c.h - wh)).toBeLessThan(1.5);
  });

  it("treats zoom below 1 as 1", () => {
    expect(cropWindow(4000, 3000, 0.8, 0.2, 0, 0).w).toBeCloseTo(2400, 5);
  });
});

describe("aspects", () => {
  it("matches the Go frame sizes", () => {
    expect(frameSize("4:5")).toEqual({ w: 1080, h: 1350 });
    expect(frameSize("1.91:1")).toEqual({ w: 1080, h: 566 });
    expect(frameSize("9:16")).toEqual({ w: 1080, h: 1920 });
    expect(aspectRatio("3:4")).toBeCloseTo(0.75, 5);
    expect(aspectRatio("1:1")).toBe(1);
  });
});

describe("rotation and zoom helpers", () => {
  it("normalises rotation", () => {
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(0)).toBe(0);
  });
  it("clamps zoom to 1..4", () => {
    expect(clampZoom(0)).toBe(1);
    expect(clampZoom(9)).toBe(4);
    expect(clampZoom(2.346)).toBe(2.35);
  });
});

describe("framedLayout", () => {
  it("fills the frame exactly when the shape matches", () => {
    const l = framedLayout(1080, 1350, 0, "4:5", 1, 0, 0);
    expect(l.box.left).toBeCloseTo(0, 5);
    expect(l.box.top).toBeCloseTo(0, 5);
    expect(l.box.width).toBeCloseTo(100, 5);
    expect(l.box.height).toBeCloseTo(100, 5);
  });

  it("crops a landscape photo to the centre of a 4:5 frame", () => {
    const l = framedLayout(4000, 3000, 0, "4:5", 1, 0, 0);
    // window x = 800 of w = 2400 -> the box starts 33.3% left of the frame and is 166.7% wide.
    expect(l.box.left).toBeCloseTo(-33.333, 2);
    expect(l.box.width).toBeCloseTo(166.667, 2);
    expect(l.box.height).toBeCloseTo(100, 5);
  });

  it("swaps the source size for 90 degree rotation", () => {
    const l = framedLayout(4000, 3000, 90, "4:5", 1, 0, 0);
    expect(l.rotW).toBe(3000);
    expect(l.rotH).toBe(4000);
    expect(l.img.width).toBeCloseTo((4000 / 3000) * 100, 5);
    expect(l.img.height).toBeCloseTo((3000 / 4000) * 100, 5);
  });
});

describe("panFromDrag", () => {
  const l = framedLayout(4000, 3000, 0, "4:5", 1, 0, 0);
  // A 2400 px window shown 400 px wide is 1/6 screen px per source px; slack is 800 source px,
  // so 133.33 screen px is a full pan.
  it("moves the window opposite to the drag", () => {
    const p = panFromDrag({ panX: 0, panY: 0 }, l, 133.3333, 0, 400);
    expect(p.panX).toBeCloseTo(-1, 2);
    expect(p.panY).toBe(0);
  });
  it("clamps and ignores axes with no slack", () => {
    const p = panFromDrag({ panX: 0.5, panY: 0.3 }, l, -1000, 500, 400);
    expect(p.panX).toBe(1);
    expect(p.panY).toBe(0.3);
  });
});
