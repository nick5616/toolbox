import { describe, expect, it } from "vitest";
import { commit, findReplace, insertAfter, mergeWithNext, newHistory, redo, shiftAll, splitCue, toCues, toRows, undo, updateCue, type CueRow } from "./logic";
import { spreadWords, splitWords } from "./words";

function withWords(): CueRow[] {
  return toRows([
    {
      startMs: 1000,
      endMs: 3000,
      text: "Hello big world",
      words: [
        { startMs: 1000, endMs: 1500, text: "Hello" },
        { startMs: 1500, endMs: 2000, text: "big" },
        { startMs: 2000, endMs: 3000, text: "world" },
      ],
    },
  ]);
}

const times = (r: CueRow | undefined) => r?.words?.map((w) => [w.startMs, w.endMs, w.text]);
const first = (rs: CueRow[]): CueRow => {
  const r = rs[0];
  if (!r) throw new Error("no rows");
  return r;
};

describe("cue words", () => {
  it("splits CJK per character and spreads by character share", () => {
    expect(splitWords("我爱 you  now")).toEqual(["我", "爱", "you", "now"]);
    expect(spreadWords("ab cdef", 0, 600).map((w) => [w.startMs, w.endMs, w.text])).toEqual([
      [0, 200, "ab"],
      [200, 600, "cdef"],
    ]);
  });

  it("round-trips words through rows and cues, and omits empty ones", () => {
    expect(toCues(withWords())[0]?.words).toHaveLength(3);
    expect(toCues(toRows([{ startMs: 0, endMs: 1, text: "a" }]))[0]).not.toHaveProperty("words");
  });

  it("re-spreads words when the text is edited", () => {
    const r = withWords();
    const out = updateCue(r, first(r).id, { text: "Hi world" });
    expect(times(out[0])).toEqual([
      [1000, 1571, "Hi"],
      [1571, 3000, "world"],
    ]);
  });

  it("leaves cues without words alone when the text changes", () => {
    const r = toRows([{ startMs: 0, endMs: 1000, text: "a" }]);
    expect(updateCue(r, first(r).id, { text: "b" })[0]?.words).toBeUndefined();
  });

  it("shifts words with a single cue time edit", () => {
    const r = withWords();
    const out = updateCue(r, first(r).id, { startMs: 1500, endMs: 3500 });
    expect(times(out[0])?.[0]).toEqual([1500, 2000, "Hello"]);
    expect(times(out[0])?.[2]).toEqual([2500, 3500, "world"]);
  });

  it("shifts words with Shift all", () => {
    const out = shiftAll(withWords(), 500);
    expect(out[0]?.startMs).toBe(1500);
    expect(times(out[0])).toEqual([
      [1500, 2000, "Hello"],
      [2000, 2500, "big"],
      [2500, 3500, "world"],
    ]);
  });

  it("splits words between the halves at a word boundary", () => {
    const out = splitCue(withWords(), 0, 5, 1500) ?? [];
    expect(times(out[0])).toEqual([[1000, 1500, "Hello"]]);
    expect(times(out[1])).toEqual([
      [1500, 2000, "big"],
      [2000, 3000, "world"],
    ]);
  });

  it("re-spreads both halves when the split falls inside a word", () => {
    const out = splitCue(withWords(), 0, 9, 1750) ?? [];
    expect(out[0]?.endMs).toBe(1750);
    expect(times(out[0])?.map((w) => w[2])).toEqual(["Hello", "big"]);
    expect(times(out[0])?.[1]?.[1]).toBe(1750);
    expect(times(out[1])).toEqual([[1750, 3000, "world"]]);
  });

  it("merges by concatenating words", () => {
    const r = [...withWords(), ...toRows([{ startMs: 3200, endMs: 4000, text: "again", words: [{ startMs: 3200, endMs: 4000, text: "again" }] }])];
    const out = mergeWithNext(r, 0) ?? [];
    expect(out).toHaveLength(1);
    expect(times(out[0])?.map((w) => w[2])).toEqual(["Hello", "big", "world", "again"]);
    expect(times(out[0])?.[3]).toEqual([3200, 4000, "again"]);
  });

  it("merges a cue without words by spreading its text", () => {
    const r = [...withWords(), ...toRows([{ startMs: 3000, endMs: 4000, text: "ab cd" }])];
    const out = mergeWithNext(r, 0) ?? [];
    expect(times(out[0])?.slice(3)).toEqual([
      [3000, 3500, "ab"],
      [3500, 4000, "cd"],
    ]);
  });

  it("inserts cues without words", () => {
    expect(insertAfter(withWords(), 0).rows[1]?.words).toBeUndefined();
  });

  it("re-spreads words on find and replace", () => {
    const out = findReplace(withWords(), "big", "enormous", false);
    expect(times(out.rows[0])?.map((w) => w[2])).toEqual(["Hello", "enormous", "world"]);
  });

  it("restores words on undo and redo", () => {
    const r = withWords();
    let h = newHistory(r);
    h = commit(h, updateCue(h.present, first(r).id, { text: "Hi" }), undefined, 0);
    expect(times(h.present[0])).toEqual([[1000, 3000, "Hi"]]);
    h = undo(h);
    expect(times(h.present[0])?.map((w) => w[2])).toEqual(["Hello", "big", "world"]);
    h = redo(h);
    expect(times(h.present[0])).toEqual([[1000, 3000, "Hi"]]);
  });
});
