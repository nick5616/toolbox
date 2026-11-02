import { describe, expect, it } from "vitest";
import type { ComposerLook } from "@/lib/api";
import { applyLook, applyMatrix, brightnessMatrix, compose, contrastMatrix, IDENTITY, isIdentityLook, LOOK_PRESETS, lookMatrix, saturationMatrix, warmthMatrix } from "./looks";

const look = (patch: Partial<ComposerLook> = {}): ComposerLook => ({ preset: "none", brightness: 0, contrast: 0, saturation: 0, warmth: 0, ...patch });
const px = (r: number, g: number, b: number, a = 255) => new Uint8ClampedArray([r, g, b, a]);
const apply = (l: ComposerLook, p: Uint8ClampedArray) => {
  applyLook(p, l);
  return Array.from(p);
};

describe("looks", () => {
  it("the neutral look is the identity and changes nothing", () => {
    expect(isIdentityLook(look())).toBe(true);
    expect(isIdentityLook(look({ preset: "" }))).toBe(true);
    expect(isIdentityLook(look({ warmth: 0.1 }))).toBe(false);
    expect(isIdentityLook(look({ preset: "mono" }))).toBe(false);
    expect(lookMatrix(look())).toEqual(Array.from(IDENTITY));
    expect(apply(look(), px(10, 200, 99, 7))).toEqual([10, 200, 99, 7]);
  });

  it("composes in order: b after a", () => {
    const a = brightnessMatrix(0.2);
    const b = contrastMatrix(0.5);
    const out = [0.3, 0.6, 0.9].map((v) => v); // r g b
    const run = (m: readonly number[]) => [0, 1, 2].map((r) => (m[r * 4] as number) * out[0]! + (m[r * 4 + 1] as number) * out[1]! + (m[r * 4 + 2] as number) * out[2]! + (m[r * 4 + 3] as number));
    const manual = run(a).map((v) => (v - 0.5) * 1.5 + 0.5);
    const composed = run(compose(a, b));
    composed.forEach((v, i) => expect(v).toBeCloseTo(manual[i] as number));
  });

  it("brightness adds, clamped to the byte range", () => {
    expect(apply(look({ brightness: 0.2 }), px(100, 100, 100))).toEqual([100 + 25.5, 100 + 25.5, 100 + 25.5, 255].map((v) => Math.round(v)));
    expect(apply(look({ brightness: 1 }), px(200, 10, 255))).toEqual([255, 138, 255, 255]);
    expect(apply(look({ brightness: -1 }), px(100, 10, 255))).toEqual([0, 0, 128, 255]);
  });

  it("contrast pivots on mid grey", () => {
    const out = apply(look({ contrast: 0.5 }), px(127.5, 200, 50));
    expect(out[0]).toBe(128);
    expect(out[1]).toBeGreaterThan(200);
    expect(out[2]).toBeLessThan(50);
    expect(apply(look({ contrast: -1 }), px(0, 255, 40))).toEqual([128, 128, 128, 255]);
  });

  it("saturation -1 is greyscale, keeping luma", () => {
    const [r, g, b] = apply(look({ saturation: -1 }), px(200, 100, 50));
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(r).toBeCloseTo(0.2126 * 200 + 0.7152 * 100 + 0.0722 * 50, 0);
    // Grey stays grey at any saturation.
    expect(apply(look({ saturation: 1 }), px(90, 90, 90)).slice(0, 3)).toEqual([90, 90, 90]);
    // +1 pulls colours apart.
    const [r2, , b2] = apply(look({ saturation: 1 }), px(200, 100, 50));
    expect(r2! - b2!).toBeGreaterThan(150);
  });

  it("warmth raises red and lowers blue", () => {
    const warm = apply(look({ warmth: 1 }), px(100, 100, 100));
    expect(warm[0]).toBeGreaterThan(100);
    expect(warm[2]).toBeLessThan(100);
    const cool = apply(look({ warmth: -1 }), px(100, 100, 100));
    expect(cool[0]).toBeLessThan(100);
    expect(cool[2]).toBeGreaterThan(100);
    expect(Array.from(applyWarm())).toEqual([120, 103, 80, 255]);
  });

  it("presets: mono and noir are grey, vivid saturates, fade lifts blacks, all keep alpha", () => {
    for (const p of ["mono", "noir"]) {
      const [r, g, b] = apply(look({ preset: p }), px(220, 40, 90));
      expect(r).toBe(g);
      expect(g).toBe(b);
    }
    const vivid = apply(look({ preset: "vivid" }), px(180, 120, 90));
    expect(vivid[0]! - vivid[2]!).toBeGreaterThan(90);
    expect(apply(look({ preset: "fade" }), px(0, 0, 0))[0]).toBeGreaterThan(10);
    expect(apply(look({ preset: "warm" }), px(100, 100, 100))[0]).toBeGreaterThan(apply(look({ preset: "cool" }), px(100, 100, 100))[0]!);
    for (const p of LOOK_PRESETS) expect(apply(look({ preset: p }), px(10, 20, 30, 77))[3]).toBe(77);
  });

  it("applyMatrix transforms every pixel", () => {
    const data = new Uint8ClampedArray([10, 20, 30, 255, 100, 110, 120, 0]);
    applyMatrix(data, saturationMatrix(-1));
    expect(Array.from(data.slice(0, 3)).every((v) => v === data[0])).toBe(true);
    expect(data[7]).toBe(0);
  });
});

function applyWarm(): Uint8ClampedArray {
  const d = px(100, 100, 100);
  applyMatrix(d, warmthMatrix(1));
  return d;
}
