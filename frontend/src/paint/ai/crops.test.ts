import { describe, expect, it } from "vitest";
import { cropRectFor, intersectRect, marginFor, planCrop, planTiles, tileWeights } from "./crops";

describe("cropRectFor", () => {
  it("adds max(64, 50%) margin and squares around the bbox", () => {
    // bbox 100x40: margin = max(64, 50) = 64 -> side 228, centred
    const r = cropRectFor({ x: 1000, y: 1000, w: 100, h: 40 }, 4000, 4000);
    expect(r.w).toBe(228);
    expect(r.h).toBe(228);
    expect(r.x + r.w / 2).toBeCloseTo(1050, 0);
    expect(r.y + r.h / 2).toBeCloseTo(1020, 0);
  });
  it("uses 50% for big boxes", () => {
    expect(marginFor({ x: 0, y: 0, w: 400, h: 100 })).toBe(200);
    expect(marginFor({ x: 0, y: 0, w: 10, h: 10 })).toBe(64);
  });
  it("clamps to the canvas, shifting to keep the size when it can", () => {
    const r = cropRectFor({ x: 0, y: 0, w: 50, h: 50 }, 1000, 1000);
    expect(r).toEqual({ x: 0, y: 0, w: 178, h: 178 });
    const b = cropRectFor({ x: 960, y: 960, w: 40, h: 40 }, 1000, 1000);
    expect(b.x + b.w).toBe(1000);
    expect(b.y + b.h).toBe(1000);
    expect(b.w).toBe(168);
  });
  it("shrinks to a small canvas and still covers the bbox", () => {
    const r = cropRectFor({ x: 10, y: 10, w: 80, h: 80 }, 100, 300);
    expect(r.w).toBe(100);
    expect(r.x).toBe(0);
    expect(r.h).toBeLessThanOrEqual(300);
    expect(r.y).toBeLessThanOrEqual(10);
    expect(r.y + r.h).toBeGreaterThanOrEqual(90);
  });
});

describe("planTiles", () => {
  it("returns one tile when it fits", () => {
    expect(planTiles({ x: 5, y: 6, w: 100, h: 100 }, 3072)).toEqual([{ x: 5, y: 6, w: 100, h: 100 }]);
  });
  it("covers the rect with overlapping tiles no bigger than max", () => {
    const r = { x: 0, y: 0, w: 7000, h: 3000 };
    const tiles = planTiles(r, 3072, 64);
    expect(tiles.length).toBe(3);
    for (const t of tiles) {
      expect(t.w).toBeLessThanOrEqual(3072);
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x + t.w).toBeLessThanOrEqual(7000);
    }
    expect(tiles[0]!.x).toBe(0);
    expect(tiles[tiles.length - 1]!.x + tiles[tiles.length - 1]!.w).toBe(7000);
    for (let i = 1; i < tiles.length; i++) {
      const ov = tiles[i - 1]!.x + tiles[i - 1]!.w - tiles[i]!.x;
      expect(ov).toBeGreaterThanOrEqual(64);
    }
  });
});

describe("planCrop", () => {
  const bounds = { x: 1500, y: 1500, w: 2000, h: 2000 }; // crop = 2000 + 2*1000 = 4000
  it("Fast above the clamp downscales the context to 1536 and does not tile up to 3072", () => {
    const big = { x: 900, y: 900, w: 1000, h: 1000 }; // crop 2000
    const p = planCrop(big, 5000, 5000, "fill", "fast");
    expect(p.tiles).toHaveLength(1);
    expect(p.rect.w).toBe(2000);
    expect(p.tiles[0]!.sendW).toBe(1536);
    expect(p.tiles[0]!.sendH).toBe(1536);
  });
  it("Best passes the context through up to 3072", () => {
    const big = { x: 900, y: 900, w: 1000, h: 1000 };
    const p = planCrop(big, 5000, 5000, "fill", "best");
    expect(p.tiles).toHaveLength(1);
    expect(p.tiles[0]!.sendW).toBe(2000);
  });
  it("tiles above 3072 and each Fast tile is downscaled", () => {
    const fast = planCrop(bounds, 6000, 6000, "fill", "fast");
    expect(fast.rect.w).toBe(4000);
    expect(fast.tiles.length).toBeGreaterThan(1);
    expect(fast.tiles.every((t) => t.sendW <= 1536)).toBe(true);
    const best = planCrop(bounds, 6000, 6000, "fill", "best");
    expect(best.tiles.every((t) => t.sendW === t.rect.w)).toBe(true);
  });
  it("enhance tiles at 1024", () => {
    const p = planCrop({ x: 1000, y: 1000, w: 700, h: 700 }, 4000, 4000, "enhance", "best"); // crop 1400
    expect(p.tiles.length).toBe(4);
    expect(p.tiles.every((t) => t.rect.w <= 1024)).toBe(true);
  });
});

describe("tileWeights", () => {
  it("ramps only on edges that border another tile", () => {
    const crop = { x: 0, y: 0, w: 300, h: 100 };
    const left = { x: 0, y: 0, w: 200, h: 100 };
    const w = tileWeights(left, crop, 64);
    expect(w[0]).toBe(1); // crop edge
    expect(w[199]).toBeLessThan(0.02); // far right edge fades
    expect(w[100]).toBe(1);
  });
});

describe("intersectRect", () => {
  it("returns null when disjoint", () => {
    expect(intersectRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 })).toBeNull();
    expect(intersectRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toEqual({ x: 5, y: 5, w: 5, h: 5 });
  });
});
