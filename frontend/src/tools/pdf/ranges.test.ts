import { describe, expect, it } from "vitest";
import { initialTiles, moveBy, moveToIndex, rangeBetween, rotateTiles, summarize, deleteTiles } from "./organize";
import { countPages, parseRanges } from "./ranges";

describe("parseRanges", () => {
  it("produces chips", () => {
    const r = parseRanges("1-3, 5, 8-");
    expect(r.error).toBe("");
    expect(r.items.map((i) => i.label)).toEqual(["1–3", "5", "8–end"]);
  });

  it("reports errors", () => {
    expect(parseRanges("").error).not.toBe("");
    expect(parseRanges("a").error).toMatch(/isn't a page range/);
    expect(parseRanges("5-3").error).toMatch(/ends before/);
    expect(parseRanges("0-2").error).toMatch(/start at 1/);
    expect(parseRanges("2, 9", 6).error).toMatch(/past the last page/);
    expect(parseRanges("2-9", 6).error).toMatch(/past the last page/);
    expect(parseRanges("1, x").items[1]?.error).toBeTruthy();
  });

  it("counts distinct pages", () => {
    expect(countPages(parseRanges("1-3, 3, 5, 8-").items, 10)).toBe(3 + 1 + 3);
  });
});

describe("organize helpers", () => {
  const ids = (t: { page: number }[]) => t.map((x) => x.page);

  it("moves selections", () => {
    const t = initialTiles(5);
    expect(ids(moveBy(t, new Set([2, 3]), -1))).toEqual([2, 3, 1, 4, 5]);
    expect(ids(moveBy(t, new Set([4, 5]), 1))).toEqual([1, 2, 3, 4, 5]);
    expect(ids(moveBy(t, new Set([1]), 1))).toEqual([2, 1, 3, 4, 5]);
    expect(ids(moveToIndex(t, new Set([1, 2]), 5))).toEqual([3, 4, 5, 1, 2]);
    expect(ids(moveToIndex(t, new Set([5]), 0))).toEqual([5, 1, 2, 3, 4]);
    expect(rangeBetween(t, 4, 2)).toEqual([2, 3, 4]);
  });

  it("summarizes", () => {
    let t = initialTiles(12);
    expect(summarize(t, 12)).toBe("12 pages");
    t = rotateTiles(t, new Set([1, 2]), 90);
    t = deleteTiles(t, new Set([5, 6, 7]));
    expect(summarize(t, 12)).toBe("9 pages (3 removed, 2 rotated)");
    expect(t[0]?.rotate).toBe(90);
    expect(rotateTiles(initialTiles(1), new Set([1]), -90)[0]?.rotate).toBe(270);
  });
});
