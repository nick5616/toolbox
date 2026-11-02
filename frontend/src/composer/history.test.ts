import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HISTORY_LIMIT, initHistory, pushEdit, redoState, undoState, useHistory } from "./history";

describe("history state", () => {
  it("push, undo, redo", () => {
    let s = initHistory(0);
    s = pushEdit(s, 1, false);
    s = pushEdit(s, 2, false);
    expect([s.past, s.present]).toEqual([[0, 1], 2]);
    s = undoState(s);
    expect([s.present, s.future]).toEqual([1, [2]]);
    s = redoState(s);
    expect(s.present).toBe(2);
    s = undoState(undoState(s));
    s = pushEdit(s, 9, false); // a new edit drops the redo branch
    expect([s.present, s.future]).toEqual([9, []]);
    expect(undoState(initHistory(1))).toEqual(initHistory(1));
    expect(redoState(initHistory(1))).toEqual(initHistory(1));
  });

  it("keeps 200 steps", () => {
    expect(HISTORY_LIMIT).toBe(200);
    let s = initHistory(0);
    for (let i = 1; i <= 250; i++) s = pushEdit(s, i, false);
    expect(s.past).toHaveLength(200);
    expect(s.past[0]).toBe(50);
  });

  it("merges into the previous step, but never the very first edit", () => {
    let s = pushEdit(initHistory(0), 1, true);
    expect(s.past).toEqual([0]);
    s = pushEdit(s, 2, true);
    s = pushEdit(s, 3, true);
    expect([s.past, s.present]).toEqual([[0], 3]);
    expect(pushEdit(s, 3, false)).toBe(s);
  });
});

describe("useHistory", () => {
  it("merges edits within 400 ms and splits after", () => {
    let t = 1000;
    const { result } = renderHook(() => useHistory(0, { now: () => t }));
    act(() => result.current.set(1)); // first: own step
    t += 100;
    act(() => result.current.set(2)); // merged
    t += 399;
    act(() => result.current.set(3)); // merged (within 400 ms of the last edit)
    t += 400;
    act(() => result.current.set(4)); // own step
    expect(result.current.value).toBe(4);
    act(() => result.current.undo());
    expect(result.current.value).toBe(3);
    act(() => result.current.undo());
    expect(result.current.value).toBe(0);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.redo());
    expect(result.current.value).toBe(3);
  });

  it("checkpoint and undo end a burst; reset forgets everything", () => {
    let t = 0;
    const { result } = renderHook(() => useHistory("a", { now: () => t }));
    act(() => result.current.set("b"));
    t += 10;
    act(() => result.current.checkpoint());
    act(() => result.current.set("c"));
    act(() => result.current.undo());
    expect(result.current.value).toBe("b");
    act(() => result.current.reset("z"));
    expect([result.current.value, result.current.canUndo, result.current.canRedo]).toEqual(["z", false, false]);
  });

  it("merging can be turned off", () => {
    const { result } = renderHook(() => useHistory(0, { coalesceMs: 0, now: () => 5 }));
    act(() => result.current.set(1));
    act(() => result.current.set(2));
    act(() => result.current.undo());
    expect(result.current.value).toBe(1);
  });
});
