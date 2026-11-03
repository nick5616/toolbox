import { describe, expect, it } from "vitest";
import { defaultTextClip } from "./schema";
import { textDocForClip } from "./textClip";

const clip = (over: Partial<ReturnType<typeof defaultTextClip>>) => ({ ...defaultTextClip("one two three"), ...over });
const starts = (d: ReturnType<typeof textDocForClip>) => d.lines.flatMap((l) => l.words.map((w) => w.startMs));

describe("textDocForClip", () => {
  it("all: every word at the clip start, line ends with the clip", () => {
    const d = textDocForClip(clip({ reveal: "all" }), 10_000, 12_000, []);
    expect(d.lines).toHaveLength(1);
    expect(starts(d)).toEqual([10_000, 10_000, 10_000]);
    expect(d.lines[0]?.endMs).toBe(12_000);
    expect(d.lines[0]?.text).toBe("one two three");
  });

  it("all with several lines shows them one after another", () => {
    const d = textDocForClip(clip({ text: "a b\nc\n\nd", reveal: "all" }), 0, 3000, []);
    expect(d.lines.map((l) => l.text)).toEqual(["a b", "c", "d"]);
    expect(d.lines.map((l) => l.startMs)).toEqual([0, 1000, 2000]);
  });

  it("words: word i at start + i*wordMs, ends at the next word", () => {
    const d = textDocForClip(clip({ reveal: "words", wordMs: 300 }), 1000, 5000, []);
    expect(starts(d)).toEqual([1000, 1300, 1600]);
    expect(d.lines[0]?.words.map((w) => w.endMs)).toEqual([1300, 1600, 5000]);
  });

  it("words continue counting across lines and clamp to the clip end", () => {
    const d = textDocForClip(clip({ text: "a b\nc d", reveal: "words", wordMs: 400 }), 0, 1000, []);
    expect(starts(d)).toEqual([0, 400, 800, 1000]);
    expect(d.lines[1]?.startMs).toBe(800);
  });

  it("beats: i-th picked marker inside the clip, leftovers at the end", () => {
    const d = textDocForClip(clip({ reveal: "beats" }), 1000, 3000, [500, 1200, 1700, 2500, 3500]);
    expect(starts(d)).toEqual([1200, 1700, 2500]);
    const e = textDocForClip(clip({ reveal: "beats", every: 2 }), 1000, 3000, [1200, 1500, 1700, 2500]);
    expect(starts(e)).toEqual([1200, 1700, 3000]);
  });

  it("beats with no markers puts everything at the end", () => {
    expect(starts(textDocForClip(clip({ reveal: "beats" }), 0, 900, []))).toEqual([900, 900, 900]);
  });

  it("empty text has no lines", () => {
    expect(textDocForClip(clip({ text: " \n " }), 0, 1000, []).lines).toEqual([]);
  });
});
