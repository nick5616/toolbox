import { describe, expect, it } from "vitest";
import { placeMenu } from "./MenuButton";

describe("placeMenu", () => {
  it("opens below with room to spare, capped to the window", () => {
    expect(placeMenu({ top: 100, bottom: 130, right: 900 }, 1200, 800)).toEqual({ top: 134, right: 300, maxHeight: 658 });
  });
  it("opens upwards near the bottom of the window, never taller than the room above", () => {
    expect(placeMenu({ top: 700, bottom: 730, right: 1180 }, 1200, 760)).toEqual({ bottom: 64, right: 20, maxHeight: 688 });
  });
  it("stays below when below has more room even if it's short", () => {
    const p = placeMenu({ top: 50, bottom: 80, right: 400 }, 1000, 280);
    expect(p.top).toBe(84);
    expect(p.maxHeight).toBe(188);
  });
  it("keeps a margin from the right edge", () => {
    expect(placeMenu({ top: 10, bottom: 40, right: 1200 }, 1200, 800).right).toBe(8);
  });
});
