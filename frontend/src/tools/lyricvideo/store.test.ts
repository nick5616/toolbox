import { beforeEach, describe, expect, it } from "vitest";
import { toRows } from "./logic";
import { designHandle, playerHandle, resetLyricVideo, useLyricVideo } from "./store";

const rows = () =>
  toRows([
    { startMs: 1000, endMs: 3000, text: "one", words: [] },
    { startMs: 4000, endMs: 6000, text: "two", words: [] },
  ]);
const st = () => useLyricVideo.getState();

beforeEach(() => resetLyricVideo());

describe("Lyric Video store", () => {
  it("edits the sheet with undo and redo, and keeps the shared flags in step", () => {
    st().resetSheet(rows());
    expect(st().canUndo).toBe(false);
    const id = st().rows[1]!.id;
    st().nudge(id, 100);
    expect(st().rows[1]?.startMs).toBe(4100);
    expect(st().canUndo).toBe(true);
    st().undo();
    expect(st().rows[1]?.startMs).toBe(4000);
    expect(st().canRedo).toBe(true);
    st().redo();
    expect(st().rows[1]?.startMs).toBe(4100);
  });

  it("keeps one undo history for the lines and the design, oldest step last to go", () => {
    let designUndos = 0;
    let designRedos = 0;
    designHandle.current = { undo: () => void designUndos++, redo: () => void designRedos++ };
    st().resetSheet(rows());
    const id = st().rows[1]!.id;
    st().nudge(id, 100); // lines step 1
    st().noteStep("design"); // design step
    st().nudge(st().rows[0]!.id, 200); // lines step 2
    expect(st().journal).toEqual(["lines", "design", "lines"]);
    st().undo();
    expect(st().rows[0]?.startMs).toBe(1000);
    expect(designUndos).toBe(0);
    st().undo(); // the design change
    expect(designUndos).toBe(1);
    expect(st().canRedo).toBe(true);
    st().undo(); // the first lines step
    expect(st().rows[1]?.startMs).toBe(4000);
    expect(st().canUndo).toBe(false);
    st().redo();
    st().redo();
    expect(designRedos).toBe(1);
    expect(st().journal).toEqual(["lines", "design"]);
    // A new edit forgets what could have been redone; resetting the design forgets its steps.
    st().nudge(st().rows[0]!.id, 50);
    expect(st().canRedo).toBe(false);
    st().dropDomain("design");
    expect(st().journal).toEqual(["lines", "lines"]);
    designHandle.current = null;
  });

  it("inserts after the selection, deletes it and selects the neighbour", () => {
    st().resetSheet(rows());
    st().select(st().rows[0]!.id);
    st().insertLine();
    expect(st().rows).toHaveLength(3);
    expect(st().selectedId).toBe(st().rows[1]?.id);
    st().deleteSelected();
    expect(st().rows).toHaveLength(2);
  });

  it("asks before a new song replaces edited lines; a fresh song resets the session but keeps the options", () => {
    st().applySong("/a.mp3");
    st().resetSheet(rows());
    st().setPrefs((p) => ({ ...p, aspect: "9:16" }));
    st().requestSong("/b.mp3"); // untouched lines: replaced at once
    expect(st().songPath).toBe("/b.mp3");
    expect(st().rows).toHaveLength(0);
    st().resetSheet(rows());
    st().shiftAll(100);
    st().requestSong("/c.mp3");
    expect(st().pendingSong).toBe("/c.mp3");
    st().resolvePendingSong(false);
    expect(st().songPath).toBe("/b.mp3");
    st().requestSong("/c.mp3");
    st().resolvePendingSong(true);
    expect(st().songPath).toBe("/c.mp3");
    expect(st().rows).toHaveLength(0);
    expect(st().prefs.aspect).toBe("9:16");
  });

  it("tap to sync stamps from the player's time and ends after the last line", () => {
    st().resetSheet(rows());
    let ms = 0;
    const calls: string[] = [];
    playerHandle.current = { play: () => calls.push("play"), pause: () => calls.push("pause"), seek: () => undefined, currentMs: () => ms } as never;
    st().startTap();
    expect(st().tapIndex).toBe(0);
    ms = 1500;
    st().stamp();
    expect(st().rows[0]?.startMs).toBe(1500);
    expect(st().tapIndex).toBe(1);
    st().tapBackOne();
    expect(st().tapIndex).toBe(0);
    st().stamp();
    ms = 4500;
    st().stamp();
    expect(st().tapIndex).toBe(-1);
    expect(calls).toEqual(["play", "pause"]);
  });

  it("job slots are independent and clearJobs forgets them", () => {
    st().setJob("gen", "g1");
    st().setJob("render", "r1");
    st().setJobError("lrc", { code: "x", message: "m" });
    expect(st().jobIds).toMatchObject({ gen: "g1", render: "r1", preview: "" });
    st().clearJobs();
    expect(st().jobIds.gen).toBe("");
    expect(st().jobErrors.lrc).toBeNull();
  });

  it("loaded options never override an edit made before they arrived", () => {
    const before = st().prefs;
    st().setPrefs((p) => ({ ...p, height: 720 }));
    st().loadPrefs({ ...before, height: 1080 });
    expect(st().prefs.height).toBe(720);
  });
});
