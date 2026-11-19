import { describe, expect, it } from "vitest";
import "@/viz/post";
import type { EditClip } from "@/lib/api";
import { newClip } from "@/editor/doc";
import { parseEffects, parseTransform, serializeEffects, serializeTransform } from "@/viz/edit/schema";
import type { EditParam } from "@/viz/edit/types";
import { serializeGain } from "./gain";
import { clipKeyTimes, deleteKeysAt, hasKeys, keyParamsAt, keyTimesOnTimeline, moveKeysAt, neighbourKey } from "./keyframes";

const keys = (...pairs: Array<[number, number]>): EditParam => ({ base: pairs[0]?.[1] ?? 0, keys: pairs.map(([t, v]) => ({ t, v, ease: "linear" as const })) });

function clip(over: Partial<EditClip> = {}): EditClip {
  return newClip({
    id: "c",
    kind: "video",
    path: "/a.mp4",
    startMs: 1000,
    endMs: 5000,
    transform: serializeTransform({ x: keys([0, 0], [1000, 0.5]), y: 0, scale: keys([1000, 1], [2000, 2]), rotation: 0, opacity: 1, crop: { l: keys([500, 0], [1000, 0.2]), r: 0, t: 0, b: 0 } }),
    effects: serializeEffects([{ id: "fx1", type: "exposure", enabled: true, params: { stops: keys([1000, 0], [3000, 3]) } }]),
    gain: serializeGain(keys([2000, 0], [3000, -12])),
    ...over,
  });
}

describe("keyframe strip", () => {
  it("merges the keyed times of every param: transform, crop, effects and gain", () => {
    expect(clipKeyTimes(clip())).toEqual([0, 500, 1000, 2000, 3000]);
  });
  it("a clip with no keys has none", () => {
    const c = newClip({ id: "p", kind: "image", path: "/p.jpg", startMs: 0, endMs: 1000 });
    expect(clipKeyTimes(c)).toEqual([]);
    expect(hasKeys(c)).toBe(false);
    expect(hasKeys(clip())).toBe(true);
  });
  it("speed keys count too", () => {
    expect(clipKeyTimes(newClip({ id: "s", kind: "video", startMs: 0, endMs: 3000, speed: JSON.stringify(keys([700, 1], [1400, 2])) }))).toEqual([700, 1400]);
  });
  it("lists which params are keyed at a time", () => {
    expect(keyParamsAt(clip(), 1000).sort()).toEqual(["effect:fx1.stops", "transform.crop.l", "transform.scale", "transform.x"].sort());
    expect(keyParamsAt(clip(), 3000).sort()).toEqual(["effect:fx1.stops", "gain"].sort());
    expect(keyParamsAt(clip(), 12345)).toEqual([]);
  });
  it("key times on the timeline add the clip's start", () => {
    expect(keyTimesOnTimeline(clip())).toEqual([1000, 1500, 2000, 3000, 4000]);
  });
});

describe("moving keys", () => {
  it("moves every key at that time in every param, and only those", () => {
    const patch = moveKeysAt(clip(), 1000, 1200);
    expect(patch).not.toBeNull();
    const next = { ...clip(), ...patch };
    expect(clipKeyTimes(next)).toEqual([0, 500, 1200, 2000, 3000]);
    const t = parseTransform(next.transform).value;
    expect(typeof t.x === "object" && t.x.keys?.map((k) => k.t)).toEqual([0, 1200]);
    expect(parseEffects(next.effects).value[0]?.params.stops).toMatchObject({ keys: [{ t: 1200 }, { t: 3000 }] });
    // Gain had no key at 1000: untouched.
    expect(patch?.gain).toBeUndefined();
  });
  it("clamps to the clip's length", () => {
    const next = { ...clip(), ...moveKeysAt(clip(), 3000, 99_999) };
    expect(clipKeyTimes(next)).toEqual([0, 500, 1000, 2000, 4000]);
    const before = { ...clip(), ...moveKeysAt(clip(), 500, -50) };
    expect(clipKeyTimes(before)[0]).toBe(0);
  });
  it("a key landing on another in the same param replaces it", () => {
    const next = { ...clip(), ...moveKeysAt(clip(), 1000, 2000) };
    const t = parseTransform(next.transform).value;
    expect(typeof t.scale === "object" && t.scale.keys?.map((k) => [k.t, k.v])).toEqual([[2000, 1]]);
  });
  it("is null when nothing moves", () => {
    expect(moveKeysAt(clip(), 1000, 1000)).toBeNull();
    expect(moveKeysAt(clip(), 777, 900)).toBeNull();
  });
});

describe("deleting keys", () => {
  it("removes the keys at a time; a param with none left goes back to its base", () => {
    const patch = deleteKeysAt(clip(), 3000);
    const next = { ...clip(), ...patch };
    expect(clipKeyTimes(next)).toEqual([0, 500, 1000, 2000]);
    expect(parseEffects(next.effects).value[0]?.params.stops).toMatchObject({ keys: [{ t: 1000 }] });
    const only = newClip({ id: "o", kind: "video", startMs: 0, endMs: 2000, transform: serializeTransform({ x: keys([500, 0.4]), y: 0, scale: 1, rotation: 0, opacity: 1 }) });
    const gone = { ...only, ...deleteKeysAt(only, 500) };
    expect(clipKeyTimes(gone)).toEqual([]);
    expect(parseTransform(gone.transform).value.x).toBe(0.4);
  });
  it("is null when there is no key at that time", () => {
    expect(deleteKeysAt(clip(), 4321)).toBeNull();
  });
});

describe("previous and next key", () => {
  it("finds neighbours strictly before and after the playhead", () => {
    const c = clip();
    expect(neighbourKey(c, 1000, 1)).toBe(1500);
    expect(neighbourKey(c, 1500, -1)).toBe(1000);
    expect(neighbourKey(c, 1000, -1)).toBeNull();
    expect(neighbourKey(c, 4000, 1)).toBeNull();
    expect(neighbourKey(c, 2500, 1)).toBe(3000);
    expect(neighbourKey(c, 2500, -1)).toBe(2000);
  });
});
