import { describe, expect, it } from "vitest";
import { emptyAnalysis } from "./emptyAnalysis";
import { editLength } from "./types";

describe("emptyAnalysis", () => {
  const a = emptyAnalysis();
  it("reads 0 everywhere", () => {
    for (const t of [-5, 0, 1234, 9_999_999]) {
      expect(a.sample("mix.energy", t)).toBe(0);
      expect(a.cum("mix.energy", t)).toBe(0);
      expect(a.vector("spectrum", t, new Float32Array(4).fill(1)).every((v) => v === 0)).toBe(true);
    }
  });
  it("has no events, beats, sections, chords or words", () => {
    expect(a.events("kick")).toEqual([]);
    expect(a.held()).toEqual([]);
    expect(a.audio.beats).toEqual([]);
    expect(a.audio.sections).toEqual([]);
    expect(a.audio.chords).toEqual([]);
    expect(a.text).toBeNull();
  });
  it("is shared", () => {
    expect(emptyAnalysis()).toBe(a);
  });
});

describe("editLength", () => {
  const song = { path: "/s.wav", startMs: 2000, endMs: 12_000, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 };
  const tr = (...ends: number[]) => [{ clips: ends.map((endMs) => ({ endMs })) }];
  it.each([
    ["song range", song, tr(50_000), 10_000],
    ["no song, no clips", null, [], 1000],
    ["no song, empty track", null, tr(), 1000],
    ["no song, short clip", null, tr(400), 1000],
    ["no song, last clip end over tracks", null, [...tr(3000, 7000), ...tr(9000)], 9000],
  ])("%s", (_n, s, tracks, want) => {
    expect(editLength({ song: s, tracks })).toBe(want);
  });
});
