import { describe, expect, it } from "vitest";
import type { Key, Marker } from "@/viz/edit/types";
import { areaOf, hitTimes, velocityRamp } from "./velocityRamp";

const keysOf = (p: ReturnType<typeof velocityRamp>): Key[] => (p && typeof p === "object" ? (p.keys ?? []) : []);
const area = (ks: Key[], len: number) => areaOf(ks.map((k) => [k.t, k.v] as const), len);

describe("velocityRamp", () => {
  for (const shape of ["hit", "rush", "start"] as const) {
    it(`${shape}: uses as much footage as a normal clip, with slow hits and fast gaps`, () => {
      const len = 2000;
      const ks = keysOf(velocityRamp({ shape, hits: "beat", intensity: 0.8 }, len, [0, 1000]));
      expect(ks.length).toBeGreaterThan(3);
      expect(area(ks, len)).toBeCloseTo(len, -1);
      for (let i = 1; i < ks.length; i++) expect((ks[i] as Key).t).toBeGreaterThan((ks[i - 1] as Key).t);
      const at0 = (ks[0] as Key).v;
      const peak = Math.max(...ks.map((k) => k.v));
      expect(peak).toBeGreaterThan(at0 * 2);
      for (const k of ks) expect(k.v).toBeGreaterThan(0);
    });
  }

  it("never uses more footage than is left in the source", () => {
    const ks = keysOf(velocityRamp({ shape: "hit", hits: "cut", intensity: 1 }, 2000, [0], 1200));
    expect(area(ks, 2000)).toBeLessThanOrEqual(1210);
  });

  it("is gentle at low intensity and skips clips that are too short", () => {
    const ks = keysOf(velocityRamp({ shape: "hit", hits: "cut", intensity: 0.1 }, 1500, [0]));
    expect(Math.max(...ks.map((k) => k.v)) / Math.min(...ks.map((k) => k.v))).toBeLessThan(1.6);
    expect(velocityRamp({ shape: "hit", hits: "cut", intensity: 1 }, 200, [0])).toBeNull();
  });

  it("finds hits: the cut plus lane markers inside the clip, 200 ms apart", () => {
    const m = (lane: Marker["lane"], ms: number): Marker => ({ id: `${lane}:${ms}`, lane, ms, strength: 1 });
    const ms = [m("beat", 900), m("beat", 1500), m("beat", 1600), m("kick", 1200), m("beat", 3000)];
    expect(hitTimes(ms, "beat", 1000, 2500)).toEqual([0, 500]);
    expect(hitTimes(ms, "cut", 1000, 2500)).toEqual([0]);
  });
});
