import { describe, expect, it } from "vitest";
import { editorReducer, EMPTY_EDITOR, isDirty, makeTab } from "./editor";
import {
  activeCueIndex,
  charsPerSecond,
  commit,
  countMatches,
  cueIssues,
  cuesKey,
  defaultSplitCaret,
  deleteCue,
  documentIssues,
  findReplace,
  insertAfter,
  mergeWithNext,
  newHistory,
  redo,
  shiftAll,
  splitCue,
  toCues,
  toRows,
  undo,
  updateCue,
  wrapText,
  type CueRow,
} from "./logic";
import { DEFAULT_PREFS, sanitizePrefs } from "./options";

function rows(...specs: Array<[number, number, string]>): CueRow[] {
  return toRows(specs.map(([startMs, endMs, text]) => ({ startMs, endMs, text })));
}

describe("cue editing", () => {
  it("splits at the caret, using the playhead when it is inside the cue", () => {
    const r = rows([0, 4000, "Hello there general Kenobi"]);
    const out = splitCue(r, 0, 11, 1500);
    expect(out?.map((c) => [c.startMs, c.endMs, c.text])).toEqual([
      [0, 1500, "Hello there"],
      [1500, 4000, "general Kenobi"],
    ]);
  });

  it("splits proportionally when the playhead is outside, and refuses empty halves", () => {
    const r = rows([1000, 3000, "abcd efgh"]);
    const out = splitCue(r, 0, 4, 9000);
    expect(out?.[0]?.endMs).toBe(1000 + Math.round((2000 * 4) / 9));
    expect(splitCue(r, 0, 0)).toBeNull();
    expect(splitCue(r, 0, 9)).toBeNull();
  });

  it("picks a default caret at the space nearest the middle", () => {
    expect(defaultSplitCaret("aaa bbbbbbbbbbbb")).toBe(3);
    expect(defaultSplitCaret("aaaaaaaa bbb")).toBe(8);
    expect(defaultSplitCaret("abcdef")).toBe(3);
  });

  it("merges with the next cue, joining text and spanning both times", () => {
    const r = rows([0, 1000, "One"], [1200, 2500, "Two"], [3000, 4000, "Three"]);
    const out = mergeWithNext(r, 0);
    expect(out?.map((c) => [c.startMs, c.endMs, c.text])).toEqual([
      [0, 2500, "One Two"],
      [3000, 4000, "Three"],
    ]);
    expect(mergeWithNext(r, 2)).toBeNull();
  });

  it("rewraps a merge that is too long onto two balanced lines", () => {
    const text = wrapText("This is a rather long first sentence. And a second one follows it.", 42);
    expect(text.split("\n")).toHaveLength(2);
    expect(text.split("\n")[0]).toBe("This is a rather long first sentence.");
    expect(wrapText("short\ntext", 42)).toBe("short text");
  });

  it("inserts into the gap after a cue", () => {
    const r = rows([0, 1000, "A"], [1500, 3000, "B"]);
    const { rows: out, id } = insertAfter(r, 0);
    expect(out).toHaveLength(3);
    const added = out.find((c) => c.id === id);
    expect(added).toMatchObject({ startMs: 1000, endMs: 1500, text: "" });
    const first = insertAfter([], -1);
    expect(first.rows[0]).toMatchObject({ startMs: 0, endMs: 2000 });
  });

  it("deletes by id and updates by id", () => {
    const r = rows([0, 1000, "A"], [1000, 2000, "B"]);
    const id = r[0]!.id;
    expect(deleteCue(r, id).map((c) => c.text)).toEqual(["B"]);
    expect(updateCue(r, id, { text: "Z" })[0]?.text).toBe("Z");
    expect(r[0]?.text).toBe("A");
  });

  it("shifts every cue and never goes below zero", () => {
    const r = rows([500, 1500, "A"], [3000, 4000, "B"]);
    const out = shiftAll(r, -1000);
    expect(out.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 500],
      [2000, 3000],
    ]);
    expect(shiftAll(r, 250).map((c) => c.startMs)).toEqual([750, 3250]);
    expect(shiftAll(rows([0, 100, "x"]), -5000)[0]).toMatchObject({ startMs: 0 });
    expect(shiftAll(rows([0, 100, "x"]), -5000)[0]!.endMs).toBeGreaterThan(0);
  });

  it("finds and replaces, honouring case", () => {
    const r = rows([0, 1000, "Cat and cat"], [1000, 2000, "dog"]);
    expect(countMatches(r, "cat", false)).toBe(2);
    expect(countMatches(r, "cat", true)).toBe(1);
    const out = findReplace(r, "cat", "fox", false);
    expect(out.count).toBe(2);
    expect(out.rows[0]?.text).toBe("fox and fox");
    expect(out.rows[1]).toBe(r[1]);
    expect(findReplace(r, "a.b", "x", false).count).toBe(0);
    expect(findReplace(r, "", "x", false).count).toBe(0);
  });

  it("finds the cue showing at a time", () => {
    const r = rows([1000, 2000, "A"], [2500, 3500, "B"], [3000, 6000, "C"]);
    expect(activeCueIndex(r, 500)).toBe(-1);
    expect(activeCueIndex(r, 1500)).toBe(0);
    expect(activeCueIndex(r, 2200)).toBe(-1);
    expect(activeCueIndex(r, 3200)).toBe(2);
    expect(activeCueIndex(r, 6000)).toBe(-1);
  });
});

describe("warnings and errors", () => {
  it("flags long lines, speed and extra lines as warnings", () => {
    const long = "x".repeat(50);
    const r = rows([0, 5000, long], [6000, 6500, "a fairly quick line of text"], [7000, 9000, "a\nb\nc"]);
    expect(cueIssues(r, 0).warnings.join()).toContain("over 42");
    expect(cueIssues(r, 1).warnings.join()).toContain("per second");
    expect(cueIssues(r, 2).warnings.join()).toContain("3 lines");
    expect(cueIssues(r, 0, 60).warnings).toEqual([]);
    expect(charsPerSecond(r[1]!)).toBeGreaterThan(20);
  });

  it("flags what the backend would reject", () => {
    const r = rows([2000, 1000, "A"], [1500, 2500, "  "], [1000, 2000, "x"]);
    expect(cueIssues(r, 0).errors).toContain("Must end after it starts");
    expect(cueIssues(r, 1).errors).toContain("Text is empty");
    expect(cueIssues(r, 2).errors).toContain("Starts before the previous subtitle");
    const doc = documentIssues(r);
    expect(doc.errorCount).toBe(3);
    expect(doc.firstError).toBe("Subtitle 1: Must end after it starts");
    expect(documentIssues(rows([0, 1000, "ok"])).errorCount).toBe(0);
  });
});

describe("history", () => {
  it("undoes and redoes", () => {
    let h = newHistory([1]);
    h = commit(h, [1, 2]);
    h = commit(h, [1, 2, 3]);
    h = undo(h);
    expect(h.present).toEqual([1, 2]);
    h = redo(h);
    expect(h.present).toEqual([1, 2, 3]);
    h = undo(undo(undo(h)));
    expect(h.present).toEqual([1]);
    expect(undo(h)).toBe(h);
  });

  it("coalesces edits with the same key inside a second, and drops redo on a new edit", () => {
    let h = newHistory("a");
    h = commit(h, "ab", "text:1", 1000);
    h = commit(h, "abc", "text:1", 1400);
    expect(h.past).toEqual(["a"]);
    h = commit(h, "abcd", "text:1", 2600);
    expect(h.past).toEqual(["a", "abc"]);
    h = undo(h);
    expect(h.future).toHaveLength(1);
    h = commit(h, "x");
    expect(h.future).toEqual([]);
  });

  it("keeps at most 100 steps", () => {
    let h = newHistory(0);
    for (let i = 1; i <= 150; i++) h = commit(h, i);
    expect(h.past).toHaveLength(100);
    expect(h.past[0]).toBe(50);
  });
});

describe("editor tabs", () => {
  it("tracks dirtiness against the saved key", () => {
    const base = rows([0, 1000, "A"]);
    let s = editorReducer(EMPTY_EDITOR, { type: "open", tab: makeTab("original", "Original", "en", base) });
    expect(isDirty(s.tabs[0]!)).toBe(false);
    s = editorReducer(s, { type: "edit", fn: (r) => updateCue(r, r[0]!.id, { text: "B" }) });
    expect(isDirty(s.tabs[0]!)).toBe(true);
    s = editorReducer(s, { type: "undo" });
    expect(isDirty(s.tabs[0]!)).toBe(false);
    s = editorReducer(s, { type: "edit", fn: (r) => updateCue(r, r[0]!.id, { text: "B" }) });
    s = editorReducer(s, { type: "saved", id: "original", key: cuesKey(s.tabs[0]!.history.present), path: "/o/a.srt" });
    expect(isDirty(s.tabs[0]!)).toBe(false);
    expect(s.tabs[0]?.savedPath).toBe("/o/a.srt");
  });

  it("adds a translation tab and replaces one in the same language", () => {
    let s = editorReducer(EMPTY_EDITOR, { type: "open", tab: makeTab("original", "Original", "en", rows([0, 1000, "A"])) });
    s = editorReducer(s, { type: "addTab", tab: makeTab("tr-es", "Spanish", "es", rows([0, 1000, "Hola"])) });
    expect(s.tabs.map((t) => t.label)).toEqual(["Original", "Spanish"]);
    expect(s.activeId).toBe("tr-es");
    s = editorReducer(s, { type: "addTab", tab: makeTab("tr-es2", "Spanish", "es", rows([0, 1000, "Buenas"])) });
    expect(s.tabs.map((t) => t.label)).toEqual(["Original", "Spanish"]);
    expect(s.tabs[1]?.history.present[0]?.text).toBe("Buenas");
    // Edits go to the active tab only.
    s = editorReducer(s, { type: "select", id: "original" });
    s = editorReducer(s, { type: "edit", fn: (r) => updateCue(r, r[0]!.id, { text: "Z" }) });
    expect(s.tabs[0]?.history.present[0]?.text).toBe("Z");
    expect(s.tabs[1]?.history.present[0]?.text).toBe("Buenas");
  });
});

describe("conversion and prefs", () => {
  it("round-trips cues", () => {
    const cues = [{ startMs: 1, endMs: 2, text: "x" }];
    expect(toCues(toRows(cues))).toEqual(cues);
    expect(toRows(null)).toEqual([]);
  });

  it("sanitizes saved prefs", () => {
    expect(sanitizePrefs({ model: "turbo", maxLineChars: 50, formats: ["vtt", "pdf"], size: "l", style: "boxed" }, DEFAULT_PREFS)).toMatchObject({
      model: "turbo",
      maxLineChars: 50,
      formats: ["vtt"],
      size: "l",
      style: "boxed",
    });
    expect(sanitizePrefs({ model: "huge", maxLineChars: 5, formats: [], style: "neon", position: "left" }, DEFAULT_PREFS)).toEqual(DEFAULT_PREFS);
    expect(sanitizePrefs(null, DEFAULT_PREFS)).toBe(DEFAULT_PREFS);
  });
});
