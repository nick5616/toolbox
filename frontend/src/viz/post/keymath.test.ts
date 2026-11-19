import { describe, expect, it } from "vitest";
import { hexToLinear } from "../palette";
import { postDef } from "./registry";
import "./index";
import { CHROMA_DEFAULTS, chokeAlpha, chromaDistance, chromaKeyAlpha, chromaKeyPixel, despill, lumaKeyAlpha, lumaKeyPixel, type ChromaParams, type Vec3, type Vec4 } from "./keymath";

const KEY = hexToLinear("#00b140") as Vec3;
const SKIN: Vec3 = hexToLinear("#d9a78c") as Vec3;
const P: ChromaParams = { key: KEY, ...CHROMA_DEFAULTS };
const opaque = (c: Vec3): Vec4 => [c[0], c[1], c[2], 1];

describe("chroma key math", () => {
  it("the key colour itself is fully transparent", () => {
    expect(chromaDistance(KEY, KEY)).toBeCloseTo(0, 9);
    expect(chromaKeyPixel(opaque(KEY), P)[3]).toBeCloseTo(0, 6);
  });
  it("a skin tone stays opaque at the defaults", () => {
    expect(chromaKeyAlpha(SKIN, P)).toBe(1);
    const out = chromaKeyPixel(opaque(SKIN), P);
    expect(out[3]).toBeCloseTo(1, 6);
  });
  it("white, black and a red shirt survive; a slightly different green is partly keyed", () => {
    for (const c of ["#ffffff", "#202020", "#c03030", "#3040c0"]) expect(chromaKeyAlpha(hexToLinear(c) as Vec3, P)).toBeGreaterThan(0.99);
    const nearGreen = hexToLinear("#20c050") as Vec3;
    expect(chromaKeyAlpha(nearGreen, P)).toBeLessThan(0.5);
  });
  it("smoothness widens the transition monotonically", () => {
    const px = hexToLinear("#40a060") as Vec3;
    const a0 = chromaKeyAlpha(px, { key: KEY, similarity: 0.1, smoothness: 0.02 });
    const a1 = chromaKeyAlpha(px, { key: KEY, similarity: 0.1, smoothness: 0.3 });
    expect(a1).toBeLessThanOrEqual(a0);
    expect(a1).toBeGreaterThanOrEqual(0);
  });
  it("amount 0 is an exact identity, and so is the source view", () => {
    const px: Vec4 = [0.1, 0.4, 0.2, 0.8];
    expect(chromaKeyPixel(px, { ...P, amount: 0 })).toEqual(px);
    expect(chromaKeyPixel(px, { ...P, view: "source" })).toEqual(px);
  });
  it("half amount blends halfway between the source and the key", () => {
    const px = opaque(KEY);
    const out = chromaKeyPixel(px, { ...P, amount: 0.5 });
    expect(out[3]).toBeCloseTo(0.5, 6);
  });
  it("output is premultiplied and the matte view shows alpha as grey", () => {
    const px: Vec4 = [SKIN[0] * 0.5, SKIN[1] * 0.5, SKIN[2] * 0.5, 0.5];
    const out = chromaKeyPixel(px, P);
    expect(out[3]).toBeCloseTo(0.5, 6);
    for (let i = 0; i < 3; i++) expect(out[i] as number).toBeLessThanOrEqual(out[3]);
    const m = chromaKeyPixel(opaque(SKIN), { ...P, view: "matte" });
    expect(m[0]).toBeCloseTo(1, 6);
    expect(m[3]).toBe(1);
    expect(chromaKeyPixel(opaque(KEY), { ...P, view: "matte" })[0]).toBeCloseTo(0, 6);
  });
  it("transparent input stays transparent", () => {
    expect(chromaKeyPixel([0, 0, 0, 0], P)[3]).toBe(0);
  });
  it("spill pulls green back toward the other channels, only where green dominates", () => {
    const spilled: Vec3 = [0.5, 0.7, 0.4];
    expect(despill(spilled, KEY, 1)).toEqual([0.5, 0.5, 0.4]);
    expect(despill(spilled, KEY, 0)).toEqual(spilled);
    expect(despill(spilled, KEY, 0.5)[1]).toBeCloseTo(0.6, 9);
    expect(despill(SKIN, KEY, 1)).toEqual(SKIN); // green is already below red
    // a blue key clamps blue
    expect(despill([0.3, 0.4, 0.8], hexToLinear("#0047bb") as Vec3, 1)).toEqual([0.3, 0.4, 0.4]);
  });
  it("choke erodes (negative) and dilates (positive) alpha", () => {
    expect(chokeAlpha(1, [1, 1, 0, 1, 1, 1, 1, 1], -1)).toBe(0);
    expect(chokeAlpha(0, [0, 0, 1, 0, 0, 0, 0, 0], 1)).toBe(1);
    expect(chokeAlpha(1, [1, 1, 0, 1, 1, 1, 1, 1], -0.5)).toBeCloseTo(0.5, 9);
    expect(chokeAlpha(0.7, [0, 1], 0)).toBe(0.7);
  });
});

describe("luma key math", () => {
  const P2 = { threshold: 0.1, softness: 0.1, invert: false, amount: 1 };
  it("keys out black and keeps white; invert flips", () => {
    expect(lumaKeyAlpha([0, 0, 0], P2)).toBe(0);
    expect(lumaKeyAlpha([1, 1, 1], P2)).toBe(1);
    expect(lumaKeyAlpha([0, 0, 0], { ...P2, invert: true })).toBe(1);
    expect(lumaKeyAlpha([1, 1, 1], { ...P2, invert: true })).toBe(0);
  });
  it("amount 0 is an identity and the output stays premultiplied", () => {
    const px: Vec4 = [0.2, 0.2, 0.2, 1];
    expect(lumaKeyPixel(px, { ...P2, amount: 0 })).toEqual(px);
    const out = lumaKeyPixel([0.002, 0.002, 0.002, 1], P2);
    expect(out[3]).toBeLessThan(1);
    expect(out[0]).toBeLessThanOrEqual(out[3]);
  });
});

describe("registration", () => {
  it("registers both passes with the spec's parameters", () => {
    const c = postDef("chromakey");
    expect(c?.kind).toBe("pass");
    expect(Object.keys(c?.params ?? {})).toEqual(["color", "similarity", "smoothness", "spill", "choke", "view", "amount"]);
    expect(c?.params.color).toMatchObject({ default: "#00b140" });
    expect(c?.params.similarity).toMatchObject({ default: 0.18 });
    expect(c?.params.choke).toMatchObject({ min: -1, max: 1 });
    const l = postDef("lumakey");
    expect(Object.keys(l?.params ?? {})).toEqual(["threshold", "softness", "invert", "amount"]);
  });
});
