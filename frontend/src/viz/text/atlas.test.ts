import { describe, expect, it } from "vitest";
import { ShelfPacker } from "./atlas";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("ShelfPacker", () => {
  it("packs rectangles side by side on one shelf", () => {
    const p = new ShelfPacker(100, 100, 0);
    expect(p.alloc(40, 20)).toEqual({ x: 0, y: 0 });
    expect(p.alloc(40, 20)).toEqual({ x: 40, y: 0 });
    expect(p.alloc(40, 20)).toEqual({ x: 0, y: 20 }); // does not fit on the first shelf
  });
  it("reuses a shelf tall enough and prefers the tightest one", () => {
    const p = new ShelfPacker(100, 200, 0);
    p.alloc(60, 50); // shelf 0: h 52
    p.alloc(60, 20); // shelf 1: h 20
    const small = p.alloc(30, 18);
    expect(small?.y).toBe(52); // fits shelf 1 (tighter) and not shelf 0's leftover
  });
  it("returns null when full or oversized", () => {
    const p = new ShelfPacker(64, 64);
    expect(p.alloc(65, 10)).toBeNull();
    expect(p.alloc(10, 65)).toBeNull();
    expect(p.alloc(0, 10)).toBeNull();
    let n = 0;
    while (p.alloc(30, 30)) n++;
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(4);
    expect(p.alloc(30, 30)).toBeNull();
  });
  it("never overlaps or leaves the page, and keeps a gap", () => {
    const p = new ShelfPacker(2048, 2048, 1);
    const placed: Rect[] = [];
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed % n) + 1;
    };
    for (let i = 0; i < 400; i++) {
      const w = 40 + rnd(300);
      const h = 60 + rnd(40);
      const at = p.alloc(w, h);
      if (!at) continue;
      const r = { ...at, w, h };
      expect(r.x + r.w).toBeLessThanOrEqual(2048);
      expect(r.y + r.h).toBeLessThanOrEqual(2048);
      // padded by the gap, no two rectangles touch
      for (const o of placed) expect(overlaps({ x: r.x, y: r.y, w: r.w + 1, h: r.h + 1 }, o)).toBe(false);
      placed.push(r);
    }
    expect(placed.length).toBeGreaterThan(100);
  });
  it("fits the words of typical lyric lines densely", () => {
    // 1080p, 70 px font: a cell is about word width + padding by 130 px tall
    const p = new ShelfPacker(2048, 2048, 1);
    let lines = 0;
    for (; lines < 100; lines++) {
      let ok = true;
      for (let w = 0; w < 6; w++) ok = p.alloc(150 + ((w * 37) % 120), 130) !== null && ok;
      if (!ok) break;
    }
    expect(lines).toBeGreaterThan(8);
  });
  it("reset empties the page", () => {
    const p = new ShelfPacker(64, 64, 0);
    p.alloc(64, 64);
    expect(p.alloc(10, 10)).toBeNull();
    p.reset();
    expect(p.count).toBe(0);
    expect(p.alloc(10, 10)).toEqual({ x: 0, y: 0 });
  });
});
