import { describe, expect, it } from "vitest";
import { MAX_KEYS, SPEED_MAX, SPEED_MIN, parseSpeed, serializeSpeed } from "@/viz/edit/schema";
import type { EditParam, Key, Marker, MarkerLane } from "@/viz/edit/types";
import { VELOCITY_PRESETS, fastToSlow, freezeOnBeat, rampIntoBeat, rampTarget, slowOnDrop, velocitySpeed } from "./velocity";

const mk = (lane: MarkerLane, ms: number): Marker => ({ id: `${lane}:${ms}`, lane, ms, strength: 1 });
const keysOf = (p: EditParam | null): Key[] => (p !== null && typeof p === "object" ? (p.keys ?? []) : []);

const clip = { startMs: 4000, endMs: 8000 };
const beats = [4000, 4500, 5000, 5500, 6000, 6500, 7000, 7500].map((t) => mk("beat", t));
const kicks = [4000, 5000, 6200, 7000].map((t) => mk("kick", t));
const drop = [mk("drop", 6000)];

function expectValid(p: EditParam | null, len: number) {
  const keys = keysOf(p);
  expect(keys.length).toBeGreaterThan(0);
  expect(keys.length).toBeLessThanOrEqual(MAX_KEYS);
  for (const [i, k] of keys.entries()) {
    expect(k.v).toBeGreaterThanOrEqual(SPEED_MIN);
    expect(k.v).toBeLessThanOrEqual(SPEED_MAX);
    expect(k.t).toBeGreaterThanOrEqual(0);
    expect(k.t).toBeLessThanOrEqual(len);
    if (i > 0) expect(k.t).toBeGreaterThan((keys[i - 1] as Key).t);
  }
  // survives the document round trip untouched
  const back = parseSpeed(serializeSpeed(p as EditParam));
  expect(back.problems).toEqual([]);
  expect(back.value).toEqual(p);
}

describe("velocity presets", () => {
  it("ramp into the beat slows to 0.4x exactly on the kick nearest the middle", () => {
    const p = rampIntoBeat([...beats, ...kicks], clip);
    expectValid(p, 4000);
    const keys = keysOf(p);
    // kicks inside at 1000, 2200, 3000 (clip-relative; the one at 0 is too close to the edge): nearest the middle (2000) is 2200
    expect(rampTarget([...beats, ...kicks], clip)).toBe(2200);
    expect(keys[0]).toMatchObject({ t: 0, v: 2 });
    const slow = keys.reduce((a, b) => (b.v < a.v ? b : a));
    expect(slow).toMatchObject({ t: 2200, v: 0.4 });
    expect(keys.at(-1)?.v).toBe(1.5);
  });

  it("falls back to beats, and is not applicable without any", () => {
    const p = rampIntoBeat(beats, clip);
    expect(keysOf(p).some((k) => k.t === 2000 && k.v === 0.4)).toBe(true);
    expect(rampIntoBeat([mk("snare", 5000)], clip)).toBeNull();
    expect(rampIntoBeat([], clip)).toBeNull();
  });

  it("ramp near the end drops the exit key instead of clamping it", () => {
    const p = rampIntoBeat([mk("kick", 7800)], clip);
    expectValid(p, 4000);
    expect(keysOf(p).map((k) => k.t)).toEqual([0, 3800]);
  });

  it("slow on the drop holds 0.3x from the drop and returns to normal", () => {
    expect(slowOnDrop(beats, clip)).toBeNull();
    const p = slowOnDrop(drop, clip);
    expectValid(p, 4000);
    const keys = keysOf(p);
    expect(keys.find((k) => k.t === 2000)?.v).toBe(0.3);
    expect(keys.find((k) => k.t === 2800)?.v).toBe(0.3);
    expect(keys.at(-1)).toMatchObject({ t: 3400, v: 1 });
  });

  it("slow on the drop at the very start of the clip has no lead-in", () => {
    const p = slowOnDrop([mk("drop", 4000)], clip);
    expectValid(p, 4000);
    expect(keysOf(p)[0]).toMatchObject({ t: 0, v: 0.3 });
  });

  it("fast to slow runs from 3x to 0.4x across the clip", () => {
    const p = fastToSlow([], clip);
    expectValid(p, 4000);
    expect(keysOf(p).map((k) => [k.t, k.v])).toEqual([[0, 3], [4000, 0.4]]);
  });

  it("freeze on the beat holds speed 0 for one beat on the beat nearest the middle", () => {
    const p = freezeOnBeat(beats, clip);
    expectValid(p, 4000);
    expect(keysOf(p).map((k) => [k.t, k.v, k.ease])).toEqual([[0, 1, "hold"], [2000, 0, "hold"], [2500, 1, "hold"]]);
    expect(freezeOnBeat([mk("kick", 5000)], clip)).toBeNull();
  });

  it("freeze at the clip start begins at 0 and a last beat holds one default beat", () => {
    const p = freezeOnBeat([mk("beat", 4000)], clip);
    expectValid(p, 4000);
    expect(keysOf(p)[0]).toMatchObject({ t: 0, v: 0 });
    expect(keysOf(p).at(-1)).toMatchObject({ t: 500, v: 1 });
  });

  it("is not applicable to clips shorter than 400 ms", () => {
    const short = { startMs: 4000, endMs: 4300 };
    for (const v of VELOCITY_PRESETS) expect(velocitySpeed(v.id, [...beats, ...kicks, ...drop], short)).toBeNull();
  });

  it("velocitySpeed dispatches by id", () => {
    expect(velocitySpeed("fast-to-slow", [], clip)).toEqual(fastToSlow([], clip));
    expect(velocitySpeed("freeze-on-beat", beats, clip)).toEqual(freezeOnBeat(beats, clip));
  });
});
