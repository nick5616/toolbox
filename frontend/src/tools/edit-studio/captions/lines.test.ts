import { describe, expect, it } from "vitest";
import type { TextLine } from "@/viz/analysis";
import { buildEditFixture } from "@/viz/edit/fixture";
import { deleteLine, effectiveLines, insertAfter, linesInRange, mergeNext, setLineText, setLineTime, setWordText, setWordTime, splitLine, srtCues } from "./lines";

const L = (startMs: number, endMs: number, text: string): TextLine => {
  const toks = text.split(" ").filter(Boolean);
  const step = (endMs - startMs) / Math.max(1, toks.length);
  return { startMs, endMs, text, words: toks.map((t, k) => ({ text: t, startMs: startMs + k * step, endMs: startMs + (k + 1) * step })) };
};

describe("caption line edits", () => {
  const base = [L(1000, 3000, "hello big world"), L(4000, 5000, "second line")];

  it("splits at the caret between words", () => {
    const out = splitLine(base, 0, "hello".length);
    expect(out.map((l) => l.text)).toEqual(["hello", "big world", "second line"]);
    expect(out[0]?.endMs).toBeGreaterThan(1000);
    expect(out[0]?.endMs).toBeLessThanOrEqual(out[1]?.startMs ?? 0);
    expect(out[0]?.words).toHaveLength(1);
    expect(out[1]?.words).toHaveLength(2);
    expect(out[1]?.endMs).toBe(3000);
  });

  it("splits in the middle without a caret and ignores single-word lines", () => {
    expect(splitLine(base, 1, -1).map((l) => l.text)).toEqual(["hello big world", "second", "line"]);
    const one = [L(0, 1000, "solo")];
    expect(splitLine(one, 0, 2)).toBe(one);
  });

  it("merges with the next line", () => {
    const out = mergeNext(base, 0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ startMs: 1000, endMs: 5000, text: "hello big world second line" });
    expect(out[0]?.words).toHaveLength(5);
    expect(mergeNext(base, 1)).toBe(base);
  });

  it("inserts in the gap, at the end and into an empty list", () => {
    const a = insertAfter(base, 0);
    expect(a).toHaveLength(3);
    expect(a[1]).toMatchObject({ startMs: 3000, endMs: 4000, text: "" });
    const b = insertAfter(base, 1);
    expect(b[2]).toMatchObject({ startMs: 5000, endMs: 7000 });
    expect(insertAfter([], -1, 1234)[0]).toMatchObject({ startMs: 1234, endMs: 3234 });
  });

  it("deletes a line", () => {
    expect(deleteLine(base, 0).map((l) => l.text)).toEqual(["second line"]);
    expect(deleteLine(base, 9)).toBe(base);
  });

  it("sets times, never letting the end precede the start, and keeps words inside", () => {
    const a = setLineTime(base, 0, { startMs: 2500 });
    expect(a[0]).toMatchObject({ startMs: 2500, endMs: 3000 });
    expect(a[0]?.words.every((w) => w.startMs >= 2500 && w.endMs <= 3000)).toBe(true);
    const b = setLineTime(base, 0, { endMs: 500 });
    expect(b[0]).toMatchObject({ startMs: 1000, endMs: 1000 });
    expect(setLineTime(base, 0, { startMs: 1000 })).toBe(base);
  });

  it("keeps word times when the word count is unchanged, else spreads", () => {
    const same = setLineText(base, 0, "hi big world");
    expect(same[0]?.words.map((w) => w.text)).toEqual(["hi", "big", "world"]);
    expect(same[0]?.words[1]?.startMs).toBe(base[0]?.words[1]?.startMs);
    const more = setLineText(base, 0, "a b c d");
    expect(more[0]?.words).toHaveLength(4);
    expect(more[0]?.words[0]?.startMs).toBe(1000);
    expect(more[0]?.words[3]?.endMs).toBe(3000);
  });

  it("edits words: text updates the line, times stay inside the line", () => {
    const a = setWordText(base, 0, 1, "BIG");
    expect(a[0]?.text).toBe("hello BIG world");
    const b = setWordTime(base, 0, 0, { startMs: 100, endMs: 99_999 });
    expect(b[0]?.words[0]).toMatchObject({ startMs: 1000, endMs: 3000 });
  });
});

describe("range and SRT cues", () => {
  const lines = [L(0, 1000, "before"), L(4000, 6000, "inside"), L(9000, 12_000, "straddles end"), L(20_000, 21_000, "after"), L(5000, 5500, "  ")];
  it("finds the lines that overlap the song range", () => {
    expect(linesInRange(lines, 3000, 10_000)).toEqual([1, 2, 4]);
  });
  it("shifts to timeline ms, clamps to 0..D and skips blank lines", () => {
    const cues = srtCues(lines, 3000, 10_000);
    expect(cues.map((c) => [c.startMs, c.endMs, c.text])).toEqual([
      [1000, 3000, "inside"],
      [6000, 7000, "straddles end"],
    ]);
    expect(srtCues([L(2000, 4000, "starts early")], 3000, 10_000)[0]).toMatchObject({ startMs: 0, endMs: 1000 });
  });
});

describe("effectiveLines", () => {
  it("uses the analysis lines until captions.lines is set", () => {
    const a = buildEditFixture();
    const fromAnalysis = effectiveLines({ lines: "" }, a);
    expect(fromAnalysis.length).toBe(a.text?.lines.length);
    const edited = effectiveLines({ lines: JSON.stringify([{ startMs: 1, endMs: 2, text: "x", words: [] }]) }, a);
    expect(edited).toEqual([{ startMs: 1, endMs: 2, text: "x", words: [] }]);
    expect(effectiveLines(null, null)).toEqual([]);
  });
});
