import { describe, expect, it } from "vitest";
import { moveItem, targetIndex } from "./reorder";

describe("reorder", () => {
  it("moves an item", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(["a", "b"], 0, 9)).toEqual(["b", "a"]);
    expect(moveItem(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });

  it("finds the drop index from the pointer", () => {
    const rects = [0, 1, 2, 3].map((i) => ({ top: i * 100, height: 80 })); // middles 40, 140, 240, 340
    expect(targetIndex(rects, 0, 10)).toBe(0);
    expect(targetIndex(rects, 0, 150)).toBe(1);
    expect(targetIndex(rects, 0, 999)).toBe(3);
    expect(targetIndex(rects, 3, -5)).toBe(0);
    expect(targetIndex(rects, 1, 120)).toBe(1);
  });
});
