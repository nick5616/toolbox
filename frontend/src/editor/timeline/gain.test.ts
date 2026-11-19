import { describe, expect, it } from "vitest";
import {
  GAIN_MAX_DB,
  GAIN_MIN_DB,
  clampFade,
  dbToFrac,
  dbToY,
  fracToDb,
  gainDbAt,
  gainKeys,
  gainPolyline,
  moveGainKey,
  nearestKey,
  parseGain,
  removeGainKey,
  serializeGain,
  setGainFlat,
  setGainKey,
  yToDb,
} from "./gain";

describe("gain JSON", () => {
  it("empty is 0 dB; numbers and key curves round-trip", () => {
    expect(parseGain("")).toBe(0);
    expect(parseGain(undefined)).toBe(0);
    expect(parseGain("-6")).toBe(-6);
    expect(serializeGain(0)).toBe("");
    expect(serializeGain(-6)).toBe("-6");
    const curve = { base: 0, keys: [{ t: 0, v: 0, ease: "linear" as const }, { t: 1000, v: -14, ease: "linear" as const }] };
    expect(parseGain(serializeGain(curve))).toEqual(curve);
  });
  it("clamps to −60..+12 and ignores junk", () => {
    expect(parseGain("99")).toBe(GAIN_MAX_DB);
    expect(parseGain("-99")).toBe(GAIN_MIN_DB);
    expect(parseGain("{oops")).toBe(0);
  });
  it("a curve with no keys left serializes as its base", () => {
    expect(serializeGain({ base: -3 })).toBe("-3");
    expect(serializeGain({ base: 0 })).toBe("");
  });
});

describe("dB ↔ line height mapping", () => {
  it("+12 dB is the top, −60 dB the bottom, 0 dB a sixth down", () => {
    expect(dbToFrac(12)).toBe(0);
    expect(dbToFrac(-60)).toBe(1);
    expect(dbToFrac(0)).toBeCloseTo(1 / 6, 10);
    expect(dbToY(0, 72)).toBeCloseTo(12, 10);
  });
  it("is clamped outside the range", () => {
    expect(dbToFrac(40)).toBe(0);
    expect(dbToFrac(-200)).toBe(1);
    expect(fracToDb(-1)).toBe(GAIN_MAX_DB);
    expect(fracToDb(2)).toBe(GAIN_MIN_DB);
  });
  it("yToDb inverts dbToY to a tenth of a dB", () => {
    for (const db of [12, 6, 0, -6, -14, -30, -60]) expect(yToDb(dbToY(db, 96), 96)).toBeCloseTo(db, 1);
  });
  it("a zero-height lane doesn't divide by zero", () => {
    expect(yToDb(5, 0)).toBe(GAIN_MAX_DB);
  });
});

describe("editing the line", () => {
  it("setGainFlat sets the whole clip; with keys it shifts the curve", () => {
    expect(setGainFlat(0, -14)).toBe(-14);
    const curve = { base: 0, keys: [{ t: 0, v: 0, ease: "linear" as const }, { t: 1000, v: -10, ease: "linear" as const }] };
    const out = setGainFlat(curve, -6);
    expect(gainKeys(out).map((k) => k.v)).toEqual([-6, -16]);
  });
  it("the first key makes a curve that keeps the flat level at both ends", () => {
    const out = setGainKey(-3, 2000, -20, 6000);
    expect(gainKeys(out).map((k) => [k.t, k.v])).toEqual([[0, -3], [2000, -20], [6000, -3]]);
  });
  it("a key at the start or end doesn't duplicate that end", () => {
    expect(gainKeys(setGainKey(0, 0, -6, 4000)).map((k) => k.t)).toEqual([0, 4000]);
    expect(gainKeys(setGainKey(0, 4000, -6, 4000)).map((k) => k.t)).toEqual([0, 4000]);
  });
  it("a second key at the same time replaces the first; times clamp to the clip", () => {
    const a = setGainKey(0, 1000, -10, 4000);
    const b = setGainKey(a, 1000, -20, 4000);
    expect(gainKeys(b).filter((k) => k.t === 1000).map((k) => k.v)).toEqual([-20]);
    expect(gainKeys(setGainKey(a, 99_999, -5, 4000)).at(-1)?.t).toBe(4000);
  });
  it("a dip under a talking clip: two keys down, two back up", () => {
    let p = setGainKey(-14, 1000, -14, 10_000);
    p = setGainKey(p, 1500, -26, 10_000);
    p = setGainKey(p, 5500, -26, 10_000);
    p = setGainKey(p, 6000, -14, 10_000);
    expect(gainDbAt(p, 0)).toBe(-14);
    expect(gainDbAt(p, 3000)).toBe(-26);
    expect(gainDbAt(p, 5750)).toBeCloseTo(-20, 5);
    expect(gainDbAt(p, 9999)).toBe(-14);
  });
  it("removeGainKey leaves a flat gain when one key remains", () => {
    const p = setGainKey(0, 1000, -10, 4000);
    expect(gainKeys(removeGainKey(p, 1000)).length).toBe(2);
    let q = removeGainKey(p, 0);
    q = removeGainKey(q, 4000);
    expect(q).toBe(-10);
    expect(removeGainKey(p, 777)).toBe(p);
  });
  it("moveGainKey moves a key in time and level and keeps order", () => {
    const p = setGainKey(0, 1000, -10, 4000); // keys at 0, 1000, 4000
    const out = moveGainKey(p, 1, 3500, -2, 4000);
    expect(gainKeys(out).map((k) => [k.t, k.v])).toEqual([[0, 0], [3500, -2], [4000, 0]]);
    expect(moveGainKey(p, 9, 0, 0, 4000)).toBe(p);
  });
  it("nearestKey picks the closest key within the tolerance", () => {
    const p = setGainKey(0, 1000, -10, 4000);
    expect(nearestKey(p, 1050, 100)).toBe(1);
    expect(nearestKey(p, 2000, 100)).toBe(-1);
    expect(nearestKey(0, 0, 100)).toBe(-1);
  });
});

describe("the polyline", () => {
  it("is flat without keys", () => {
    const pts = gainPolyline(-6, 2000, 100, 72);
    expect(pts).toEqual([{ x: 0, y: dbToY(-6, 72) }, { x: 200, y: dbToY(-6, 72) }]);
  });
  it("runs through the keys and holds flat to both ends", () => {
    const p = { base: 0, keys: [{ t: 500, v: -10, ease: "linear" as const }, { t: 1500, v: -20, ease: "linear" as const }] };
    const pts = gainPolyline(p, 2000, 100, 72);
    expect(pts.map((q) => q.x)).toEqual([0, 50, 150, 200]);
    expect(pts[0]?.y).toBe(pts[1]?.y);
    expect(pts[3]?.y).toBe(pts[2]?.y);
  });
});

describe("fades", () => {
  it("clamp to 0..10 s and so the two never cross", () => {
    expect(clampFade(-5, 4000, 0)).toBe(0);
    expect(clampFade(99_999, 60_000, 0)).toBe(10_000);
    expect(clampFade(3000, 4000, 2000)).toBe(2000);
    expect(clampFade(1234.6, 4000, 0)).toBe(1235);
  });
});
