import { describe, expect, it } from "vitest";
import {
  deleteRow,
  documentIssues,
  editorReducer,
  insertAfter,
  karaokeProgress,
  latestStarted,
  lineAt,
  newHistory,
  nudgeLine,
  setLineStart,
  setLineText,
  shiftAll,
  spreadWords,
  suspectIds,
  tagValue,
  tapBack,
  tapStamp,
  toLines,
  toRows,
  type Row,
} from "./logic";

function rows(): Row[] {
  return toRows([
    { startMs: 1000, endMs: 3000, text: "hello big world", words: [
      { startMs: 1000, endMs: 1500, text: "hello" },
      { startMs: 1500, endMs: 2000, text: "big" },
      { startMs: 2000, endMs: 3000, text: "world" },
    ] },
    { startMs: 4000, endMs: 6000, text: "second line", words: [] },
    { startMs: 7000, endMs: 8000, text: "third", words: [] },
  ]);
}

describe("nudge and start edits", () => {
  it("nudging moves the line, its end and its words together", () => {
    const r = rows();
    const id = r[0]!.id;
    const next = nudgeLine(r, id, 100);
    expect(next[0]!.startMs).toBe(1100);
    expect(next[0]!.endMs).toBe(3100);
    expect(next[0]!.words.map((w) => w.startMs)).toEqual([1100, 1600, 2100]);
    expect(next[0]!.words.map((w) => w.endMs)).toEqual([1600, 2100, 3100]);
    expect(next[1]).toBe(r[1]);
  });

  it("never nudges before zero", () => {
    const r = rows();
    const id = r[0]!.id;
    const a = nudgeLine(r, id, -5000);
    expect(a[0]!.startMs).toBe(0);
    expect(a[0]!.endMs).toBe(2000);
    expect(a[0]!.words[0]!.startMs).toBe(0);
  });

  it("setting an unchanged start keeps the same array", () => {
    const r = rows();
    expect(setLineStart(r, r[0]!.id, 1000)).toBe(r);
  });

  it("shift all moves every word but stops at zero", () => {
    const r = rows();
    const later = shiftAll(r, 250);
    expect(later.map((x) => x.startMs)).toEqual([1250, 4250, 7250]);
    expect(later[0]!.words[2]!.endMs).toBe(3250);
    const earlier = shiftAll(r, -5000);
    expect(earlier.map((x) => x.startMs)).toEqual([0, 3000, 6000]);
  });

  it("text edits re-spread the words over the line", () => {
    const r = rows();
    const next = setLineText(r, r[1]!.id, "ab cdef");
    const words = next[1]!.words;
    expect(words.map((w) => w.text)).toEqual(["ab", "cdef"]);
    expect(words[0]!.startMs).toBe(4000);
    expect(words[1]!.endMs).toBe(6000);
    expect(words[0]!.endMs).toBe(words[1]!.startMs);
    expect(setLineText(r, r[1]!.id, "")[1]!.words).toEqual([]);
  });

  it("spreadWords shares time by character count", () => {
    const w = spreadWords("aa bbbb", 0, 600);
    expect(w).toEqual([
      { startMs: 0, endMs: 200, text: "aa" },
      { startMs: 200, endMs: 600, text: "bbbb" },
    ]);
  });
});

describe("tap to sync", () => {
  it("stamps the current line and advances", () => {
    const r = rows();
    const res = tapStamp(r, 0, 1234);
    expect(res.rows[0]!.startMs).toBe(1234);
    expect(res.rows[0]!.endMs).toBe(3234);
    expect(res.next).toBe(1);
    expect(res.done).toBe(false);
  });

  it("is done after the last line", () => {
    const r = rows();
    const res = tapStamp(r, 2, 9000);
    expect(res.done).toBe(true);
    expect(res.rows[2]!.startMs).toBe(9000);
  });

  it("pushes later lines forward to keep the order", () => {
    const r = rows();
    const res = tapStamp(r, 0, 5000);
    const starts = res.rows.map((x) => x.startMs);
    expect(starts).toEqual([5000, 5000, 7000]);
    expect(documentIssues(res.rows).firstOutOfOrder).toBe(-1);
    // a big jump drags every later line along
    const big = tapStamp(r, 0, 20000).rows.map((x) => x.startMs);
    expect(big).toEqual([20000, 20000, 20000]);
  });

  it("cuts the previous line off where the next one starts", () => {
    const r = rows();
    const res = tapStamp(r, 1, 3500);
    expect(res.rows[0]!.endMs).toBe(3000);
    const res2 = tapStamp(r, 1, 2500);
    expect(res2.rows[0]!.endMs).toBe(2500);
    expect(res2.rows[0]!.words.every((w) => w.endMs <= 2500)).toBe(true);
  });

  it("ignores an out-of-range index and backspace goes back one line, never below 0", () => {
    const r = rows();
    expect(tapStamp(r, 9, 100).rows).toBe(r);
    expect(tapBack(2)).toBe(1);
    expect(tapBack(0)).toBe(0);
  });
});

describe("rows", () => {
  it("inserts between neighbours in time", () => {
    const r = rows();
    const res = insertAfter(r, 0);
    expect(res.rows).toHaveLength(4);
    const n = res.rows[1]!;
    expect(n.id).toBe(res.id);
    expect(n.startMs).toBe(3000);
    expect(n.endMs).toBe(4000);
    expect(documentIssues(res.rows).firstOutOfOrder).toBe(-1);
    expect(insertAfter([], -1).rows[0]!.startMs).toBe(0);
  });

  it("deletes by id", () => {
    const r = rows();
    expect(deleteRow(r, r[1]!.id).map((x) => x.text)).toEqual(["hello big world", "third"]);
  });

  it("finds the line at a time", () => {
    const r = rows();
    expect(lineAt(r, 500)).toBe(-1);
    expect(lineAt(r, 1000)).toBe(0);
    expect(lineAt(r, 3500)).toBe(-1);
    expect(lineAt(r, 4000)).toBe(1);
    expect(latestStarted(r, 3500)).toBe(0);
    expect(latestStarted(r, 100)).toBe(-1);
  });

  it("drops blank lines from the job lines", () => {
    const r = insertAfter(rows(), 0).rows;
    expect(toLines(r)).toHaveLength(3);
  });
});

describe("karaokeProgress", () => {
  it("follows the word times", () => {
    const row = rows()[0]!;
    expect(karaokeProgress(row, 900)).toBe(0);
    // "hello" (5 chars of 13) fully sung at 1500
    expect(karaokeProgress(row, 1500)).toBeCloseTo(5 / 13);
    // half way through "big" (3 chars)
    expect(karaokeProgress(row, 1750)).toBeCloseTo((5 + 1.5) / 13);
    expect(karaokeProgress(row, 3000)).toBe(1);
    expect(karaokeProgress(row, 99999)).toBe(1);
  });

  it("holds through a gap between words", () => {
    const row: Row = {
      id: "x", startMs: 0, endMs: 3000, text: "aa bb",
      words: [{ startMs: 0, endMs: 500, text: "aa" }, { startMs: 2000, endMs: 3000, text: "bb" }],
    };
    expect(karaokeProgress(row, 1000)).toBeCloseTo(0.5);
    expect(karaokeProgress(row, 1500)).toBeCloseTo(0.5);
  });

  it("is linear over the line when it has no words", () => {
    const row = rows()[1]!;
    expect(karaokeProgress(row, 5000)).toBeCloseTo(0.5);
  });
});

describe("checks and history", () => {
  it("flags out-of-order lines and empty documents", () => {
    const r = rows();
    expect(documentIssues(r).blocker).toBe("");
    const bad = setLineStart(r, r[2]!.id, 100);
    const d = documentIssues(bad);
    expect(d.firstOutOfOrder).toBe(2);
    expect(d.blocker).toMatch(/Line 3 starts before/);
    expect(documentIssues([]).blocker).toMatch(/at least one line/);
  });

  it("suspects very short, very long or too-fast lines", () => {
    const r: Row[] = [
      { id: "a", startMs: 0, endMs: 100, text: "short", words: [] },
      { id: "b", startMs: 0, endMs: 3000, text: "fine line", words: [] },
      { id: "c", startMs: 0, endMs: 20000, text: "slow", words: [] },
    ];
    expect([...suspectIds(r)].sort()).toEqual(["a", "c"]);
  });

  it("undo and redo work and coalesce rapid same-key edits", () => {
    let h = newHistory(rows());
    const id = h.present[0]!.id;
    h = editorReducer(h, { type: "edit", fn: (r) => nudgeLine(r, id, 100), key: "n", at: 1000 });
    h = editorReducer(h, { type: "edit", fn: (r) => nudgeLine(r, id, 100), key: "n", at: 1200 });
    expect(h.present[0]!.startMs).toBe(1200);
    expect(h.past).toHaveLength(1);
    h = editorReducer(h, { type: "undo" });
    expect(h.present[0]!.startMs).toBe(1000);
    h = editorReducer(h, { type: "redo" });
    expect(h.present[0]!.startMs).toBe(1200);
    h = editorReducer(h, { type: "reset", rows: [] });
    expect(h.present).toEqual([]);
    expect(h.past).toEqual([]);
  });

  it("reads tags in any case", () => {
    expect(tagValue({ TITLE: " Song " }, "title")).toBe("Song");
    expect(tagValue(null, "title")).toBe("");
  });
});
