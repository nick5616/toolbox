import { describe, expect, it } from "vitest";
import { fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("returns null when not a subsequence", () => {
    expect(fuzzyScore("xyz", "Settings")).toBeNull();
    expect(fuzzyScore("tsa", "Settings")).toBeNull();
    expect(fuzzyScore("abcd", "abc")).toBeNull();
  });

  it("matches case-insensitively and reports indices", () => {
    const m = fuzzyScore("SET", "Open Settings");
    expect(m?.indices).toEqual([5, 6, 7]);
  });

  it("empty query matches with score 0", () => {
    expect(fuzzyScore("", "anything")).toEqual({ score: 0, indices: [] });
  });

  it("ranks word-start above mid-word", () => {
    const a = fuzzyScore("set", "Settings")!;
    const b = fuzzyScore("set", "Reset")!;
    expect(a.score).toBeGreaterThan(b.score);
  });

  it("ranks consecutive above scattered", () => {
    const a = fuzzyScore("abc", "abcx")!;
    const b = fuzzyScore("abc", "axbxc")!;
    expect(a.score).toBeGreaterThan(b.score);
  });

  it("prefers word-start alignment for initials", () => {
    const m = fuzzyScore("tj", "Toggle job tray")!;
    expect(m.indices).toEqual([0, 7]);
  });
});
