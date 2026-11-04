import { describe, expect, it } from "vitest";
import { IDENTITY_TRANSFORM } from "@/viz/edit/schema";
import type { EditMod, Marker } from "@/viz/edit/types";
import { kenBurns, KB_DRIFT, KB_SCALE_IN, markersInClip } from "./kenBurns";
import { paramKeys } from "./paramOps";

const m = (lane: Marker["lane"], ms: number): Marker => ({ id: `${lane}:${ms}`, lane, ms, strength: 1 });
const markers = [m("kick", 500), m("beat", 1000), m("kick", 1500), m("kick", 2500), m("kick", 3000), m("kick", 4500), m("kick", 6000)];
const clip = { startMs: 1000, endMs: 5000 };

describe("kenBurns", () => {
  it("picks the active lane's markers inside the clip", () => {
    expect(markersInClip(markers, "kick", 1000, 5000).map((x) => x.ms)).toEqual([1500, 2500, 3000, 4500]);
    expect(markersInClip(markers, "snare", 1000, 5000)).toEqual([]);
    // the end is exclusive
    expect(markersInClip(markers, "kick", 1000, 4500).map((x) => x.ms)).toEqual([1500, 2500, 3000]);
  });

  it("alternates scale 1.0 / 1.12 with ±0.03 drift at clip-relative times", () => {
    const t = kenBurns(IDENTITY_TRANSFORM, markers, "kick", clip);
    expect(t).not.toBeNull();
    const scale = paramKeys((t as NonNullable<typeof t>).scale);
    expect(scale.map((k) => [k.t, k.v])).toEqual([
      [500, 1],
      [1500, KB_SCALE_IN],
      [2000, 1],
      [3500, KB_SCALE_IN],
    ]);
    const x = paramKeys((t as NonNullable<typeof t>).x).map((k) => k.v);
    const y = paramKeys((t as NonNullable<typeof t>).y).map((k) => k.v);
    expect(x).toEqual([-KB_DRIFT, KB_DRIFT, -KB_DRIFT, KB_DRIFT]);
    expect(y).toEqual([-KB_DRIFT, -KB_DRIFT, KB_DRIFT, KB_DRIFT]);
    for (const v of [...x, ...y]) expect(Math.abs(v)).toBeLessThanOrEqual(0.03);
  });

  it("keeps rotation, opacity, bases and reactions", () => {
    const mod: EditMod = { signal: "marker.kick", amount: 0.1, shape: "exp" };
    const t = kenBurns({ ...IDENTITY_TRANSFORM, rotation: 5, opacity: 0.5, scale: { base: 1.1, mods: [mod] } }, markers, "kick", clip);
    expect(t?.rotation).toBe(5);
    expect(t?.opacity).toBe(0.5);
    expect(t?.scale).toMatchObject({ base: 1.1, mods: [mod] });
  });

  it("returns null when the clip holds no marker of the lane", () => {
    expect(kenBurns(IDENTITY_TRANSFORM, markers, "drop", clip)).toBeNull();
  });
});
