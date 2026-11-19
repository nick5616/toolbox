import { describe, expect, it } from "vitest";
import { CORNER_EDGES, cropCorners, cropEdgeFromPoint, cropHandlePoint } from "./cropGeometry";
import type { Box } from "./overlayGeometry";

const box: Box = { cx: 400, cy: 300, w: 400, h: 200, rotation: 0 }; // spans x 200..600, y 200..400
const none = { l: 0, r: 0, t: 0, b: 0 };

describe("crop geometry", () => {
  it("edges from a pointer position", () => {
    expect(cropEdgeFromPoint(box, { x: 300, y: 300 }, "l")).toBeCloseTo(0.25, 9);
    expect(cropEdgeFromPoint(box, { x: 500, y: 300 }, "r")).toBeCloseTo(0.25, 9);
    expect(cropEdgeFromPoint(box, { x: 400, y: 250 }, "t")).toBeCloseTo(0.25, 9);
    expect(cropEdgeFromPoint(box, { x: 400, y: 350 }, "b")).toBeCloseTo(0.25, 9);
  });
  it("clamps to 0..0.45", () => {
    expect(cropEdgeFromPoint(box, { x: 100, y: 300 }, "l")).toBe(0);
    expect(cropEdgeFromPoint(box, { x: 500, y: 300 }, "l")).toBe(0.45);
    expect(cropEdgeFromPoint(box, { x: 700, y: 300 }, "r")).toBe(0);
  });
  it("follows the box's rotation", () => {
    const turned: Box = { ...box, w: 200, h: 200, rotation: 90 };
    // rotated 90° clockwise, the picture's left edge is the top of the box on screen; its centre is at the box centre
    expect(cropEdgeFromPoint(turned, { x: 400, y: 250 }, "l")).toBeCloseTo(0.25, 9);
  });
  it("handles sit on the crop lines, halfway along the kept part", () => {
    const c = { l: 0.1, r: 0.2, t: 0, b: 0.4 };
    expect(cropHandlePoint(box, c, "l")).toEqual({ x: 240, y: 300 - 40 });
    expect(cropHandlePoint(box, c, "r")).toEqual({ x: 520, y: 260 });
    expect(cropHandlePoint(box, c, "t")).toEqual({ x: 200 + ((0.1 + 0.8) / 2) * 400, y: 200 });
    expect(cropHandlePoint(box, c, "b")).toEqual({ x: 200 + 0.45 * 400, y: 320 });
  });
  it("handles are nudged into the frame", () => {
    const p = cropHandlePoint({ ...box, cx: 0, cy: 100 }, none, "l", { w: 500, h: 300 });
    expect(p.x).toBe(10);
  });
  it("corners of the kept rectangle", () => {
    expect(cropCorners(box, { l: 0.25, r: 0.25, t: 0.5, b: 0 })).toEqual([
      { x: 300, y: 300 },
      { x: 500, y: 300 },
      { x: 500, y: 400 },
      { x: 300, y: 400 },
    ]);
  });
  it("a corner crops its two edges", () => {
    expect(CORNER_EDGES.br).toEqual(["r", "b"]);
  });
});
