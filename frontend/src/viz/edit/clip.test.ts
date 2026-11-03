import { describe, expect, it } from "vitest";
import { buildMaskUniforms, coverSize, evalTransform, fitGeometry, resolvePostParams, subdividePath } from "./clip";
import { aheadKeys } from "./EditCanvas";
import { ImageLRU, Pool } from "./pool";
import { newMask } from "./schema";
import type { ClipTransform } from "./types";

describe("fit geometry", () => {
  it("fill covers the frame, centre-cropped", () => {
    const g = fitGeometry("fill", 1920, 1080, 540, 960); // landscape source into a portrait frame
    expect(g.box[1]).toBeCloseTo(960, 6);
    expect(g.box[0]).toBeCloseTo((1920 * 960) / 1080, 6);
    expect(g.img).toEqual(g.box);
  });

  it("fit contains the source in a frame-sized box", () => {
    const g = fitGeometry("fit-blur", 1920, 1080, 540, 960);
    expect(g.box).toEqual([540, 960]);
    expect(g.img[0]).toBeCloseTo(540, 6);
    expect(g.img[1]).toBeCloseTo(540 * (1080 / 1920), 6);
  });

  it("cover size is the fill size", () => {
    expect(coverSize(100, 100, 50, 80)).toEqual([80, 80]);
  });
});

describe("transform", () => {
  const t: ClipTransform = { x: 0.25, y: -0.5, scale: 2, rotation: 90, opacity: 0.5 };
  it("converts to pixels and radians", () => {
    const v = evalTransform(t, 540, 960, 0, 0, null);
    expect(v.offX).toBe(135);
    expect(v.offY).toBe(-480);
    expect(v.scale).toBe(2);
    expect(v.rot).toBeCloseTo(Math.PI / 2, 9);
    expect(v.opacity).toBe(0.5);
  });
});

describe("paths", () => {
  const square: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  it("leaves a straight path alone", () => {
    expect(subdividePath(square, false)).toEqual(square);
  });

  it("subdivides a smooth path into at most 32 segments and passes through the points", () => {
    const s = subdividePath(square, true);
    expect(s.length).toBe(32);
    expect(s[0]).toEqual([0, 0]); // Catmull-Rom interpolates its control points
    expect(s[8]?.[0]).toBeCloseTo(1, 9);
    const many: Array<[number, number]> = Array.from({ length: 20 }, (_, i) => [Math.cos(i), Math.sin(i)]);
    expect(subdividePath(many, true).length).toBeLessThanOrEqual(32);
    expect(subdividePath(many, true).length).toBe(20); // one segment per point when there is no room
  });
});

describe("mask uniforms", () => {
  it("evaluates a rect mask in box pixels", () => {
    const m = newMask("m", "rect");
    m.w = 0.5;
    m.h = 0.25;
    m.feather = 0.1;
    m.op = "intersect";
    m.invert = true;
    const u = buildMaskUniforms([m], [200, 400], 0, 0, null);
    expect(u.count).toBe(1);
    expect([...u.a.slice(0, 4)]).toEqual([100, 200, 50, 50]);
    expect(u.b[1]).toBeCloseTo(20, 4); // 10 % of the short side
    expect(u.b[2]).toBe(1);
    expect(u.b[3]).toBe(2);
    expect(u.c[0]).toBe(0);
  });

  it("turns a path into a polygon scaled and moved by the params", () => {
    const m = newMask("p", "path");
    m.x = 0.5;
    m.y = 0.5;
    m.w = 2;
    m.h = 2;
    const u = buildMaskUniforms([m], [100, 100], 0, 0, null);
    expect(u.c[0]).toBe(2);
    expect(u.c[2]).toBe(4);
    // the default points sit at 0.3 / 0.7: scaled by 2 around the centre → 0.1 / 0.9 of the box
    expect(u.pts[0]).toBeCloseTo(10, 4);
    expect(u.pts[1]).toBeCloseTo(10, 4);
    expect(u.pts[2]).toBeCloseTo(90, 4);
  });

  it("allows at most four masks and numbers them in order", () => {
    const list = Array.from({ length: 6 }, (_, i) => newMask(`m${i}`, "ellipse"));
    const u = buildMaskUniforms(list, [100, 100], 0, 0, null);
    expect(u.count).toBe(4);
    expect(u.c[4]).toBe(1);
  });
});

describe("post parameters", () => {
  it("resolves numbers, defaults and non-numbers", () => {
    const v = resolvePostParams(
      {
        amount: { kind: "number", label: "A", min: 0, max: 1, default: 0.3 },
        zoom: { kind: "number", label: "Z", min: 0, max: 1, default: 0.5 },
        mode: { kind: "enum", label: "M", options: ["add", "screen"], default: "add" },
        on: { kind: "bool", label: "O", default: true },
      },
      { amount: 2, mode: "screen" },
      0,
      0,
      null,
    );
    expect(v).toEqual({ amount: 1, zoom: 0.5, mode: "screen", on: true });
  });
});

describe("pools", () => {
  it("reuses released resources and keeps at most `retain` idle", () => {
    const destroyed: number[] = [];
    let n = 0;
    const pool = new Pool<{ w: number; h: number; id: number }>(
      (w, h) => ({ w, h, id: n++ }),
      (t) => destroyed.push(t.id),
      2,
    );
    const a = pool.acquire(10, 10);
    const b = pool.acquire(10, 10);
    const c = pool.acquire(10, 10);
    expect(pool.outstanding).toBe(3);
    pool.release(a);
    pool.release(b);
    pool.release(c); // the third idle one is destroyed
    expect(destroyed).toEqual([c.id]);
    expect(pool.outstanding).toBe(0);
    expect(pool.acquire(10, 10).id).toBe(b.id);
    expect(pool.acquire(5, 5).id).toBe(3);
    expect(pool.created).toBe(4);
    pool.trim();
    expect(destroyed).toContain(a.id);
  });

  it("evicts the least recently used image and destroys each value once", () => {
    const destroyed: string[] = [];
    const lru = new ImageLRU<string>(2, (v) => destroyed.push(v));
    const a = {};
    const b = {};
    const c = {};
    lru.set(a, "a");
    lru.set(b, "b");
    lru.get(a);
    lru.set(c, "c");
    expect(destroyed).toEqual(["b"]);
    expect(lru.get(b)).toBeUndefined();
    lru.clear();
    expect(destroyed.sort()).toEqual(["a", "b", "c"]);
  });
});

describe("decode-ahead keys", () => {
  it("collects the next half second in play order without duplicates", () => {
    const needs = (t: number) => [{ stream: "v:a", frame: Math.floor(t / 10) }];
    const keys = aheadKeys(needs, 0, 30);
    expect(keys.length).toBe(15);
    expect(keys[0]).toEqual({ stream: "v:a", frame: 3 }); // 33 ms
    const dup = aheadKeys(() => [{ stream: "v:a", frame: 1 }], 0, 30);
    expect(dup).toHaveLength(1);
  });
});
