import { describe, expect, it } from "vitest";
import { thumbGeometry } from "./TimeScrollbar";

describe("thumbGeometry", () => {
  it("hides when everything fits", () => {
    expect(thumbGeometry(400, 10_000, 100, 0, 1000).visible).toBe(false);
  });
  it("sizes and places the thumb by the visible share", () => {
    // 10 s visible of 40 s on a 400 px bar → 100 px thumb; scrolled to the end → right edge
    expect(thumbGeometry(400, 40_000, 100, 0, 1000)).toEqual({ left: 0, width: 100, visible: true });
    expect(thumbGeometry(400, 40_000, 100, 30_000, 1000)).toEqual({ left: 300, width: 100, visible: true });
    expect(thumbGeometry(400, 4_000_000, 100, 0, 1000).width).toBe(24);
  });
});
