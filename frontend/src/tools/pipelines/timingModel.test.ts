import { describe, expect, it } from "vitest";
import { focusAction, focusBands, focusSpans, isTimeStep, type TimingStep } from "./editorModel";
import { addTime, daysText, nextFireText, removeTimeAt, scheduleLine, scheduleOf, scheduleProblem, scheduleSummary, setTimeAt, sortTimes, toggleDay } from "./scheduleModel";
import { clockText, isTimeWait, remainingText, timeWaitText } from "./timeWait";
import { CellStatus, WaitKind } from "@/lib/api";

const f = (id: string, action: string, extra: Record<string, unknown> = {}): TimingStep => ({ id, type: "focus", optionsJson: JSON.stringify({ action, ...extra }) });
const other = (id: string, type = "converter"): TimingStep => ({ id, type, optionsJson: "{}" });

describe("focusSpans", () => {
  it.each<[string, TimingStep[], Array<[string, string, string]>]>([
    ["no focus steps", [other("a"), other("b")], []],
    ["a start with nothing to wait on", [f("s", "start"), other("a")], []],
    ["a wait with no start", [other("a"), f("w", "wait")], []],
    ["a start and the next wait", [f("s", "start", { minutes: 50 }), other("a"), f("w", "wait")], [["s", "w", "50 min"]]],
    ["a start and an end only", [f("s", "start", { minutes: 50 }), f("e", "end")], []],
    ["the wait pairs with the nearest earlier start", [f("s1", "start", { minutes: 25 }), f("s2", "start", { minutes: 90 }), f("w", "wait")], [["s2", "w", "1 h 30 min"]]],
    ["two sessions in a row", [f("s1", "start", { minutes: 25 }), f("w1", "wait"), f("s2", "start", { minutes: 120 }), f("w2", "wait")], [["s1", "w1", "25 min"], ["s2", "w2", "2 h"]]],
    ["a second wait has no start left", [f("s", "start", { minutes: 25 }), f("w1", "wait"), f("w2", "wait")], [["s", "w1", "25 min"]]],
    ["until mode labels the time", [f("s", "start", { mode: "until", at: "17:30" }), f("w", "wait")], [["s", "w", "until 17:30"]]],
    ["unreadable options label nothing", [{ id: "s", type: "focus", optionsJson: "oops" }, f("w", "wait")], [["s", "w", ""]]],
  ])("%s", (_name, steps, want) => {
    expect(focusSpans(steps).map((s) => [s.startId, s.waitId, s.label])).toEqual(want);
  });

  it("records the step positions", () => {
    const [s] = focusSpans([other("a"), f("s", "start"), other("b"), f("w", "wait")]);
    expect(s).toMatchObject({ startIndex: 1, waitIndex: 3 });
  });
});

describe("focus actions and clock badges", () => {
  it("reads the action, defaulting to start", () => {
    expect(focusAction(f("a", "wait"))).toBe("wait");
    expect(focusAction(f("a", "end"))).toBe("end");
    expect(focusAction({ id: "a", type: "focus", optionsJson: "{}" })).toBe("start");
    expect(focusAction(other("a"))).toBe("");
  });

  it("badges Wait and Focus wait only", () => {
    expect(isTimeStep(other("a", "pipelines.wait"))).toBe(true);
    expect(isTimeStep(f("a", "wait"))).toBe(true);
    expect(isTimeStep(f("a", "start"))).toBe(false);
    expect(isTimeStep(f("a", "end"))).toBe(false);
    expect(isTimeStep(other("a"))).toBe(false);
    expect(isTimeStep(undefined)).toBe(false);
  });
});

describe("focusBands", () => {
  const nodes = [
    { id: "s", x: 100, y: 50, w: 200, h: 100 },
    { id: "m", x: 340, y: 60, w: 200, h: 120 },
    { id: "w", x: 580, y: 50, w: 200, h: 100 },
  ];
  it("surrounds the nodes of a span with padding", () => {
    const [b] = focusBands([{ startId: "s", waitId: "w", startIndex: 0, waitIndex: 2, ids: ["s", "m", "w"], label: "50 min" }], nodes, 10);
    expect(b).toMatchObject({ x: 90, w: 700, label: "50 min" });
    expect(b!.y).toBeLessThan(50);
    expect(b!.y + b!.h).toBeGreaterThan(180); // the taller middle node is inside the band
  });
  it("drops a span whose nodes are missing", () => {
    expect(focusBands([{ startId: "s", waitId: "gone", startIndex: 0, waitIndex: 2, ids: ["s", "gone"], label: "" }], nodes)).toEqual([]);
  });
});

describe("schedule editing", () => {
  it("toggles days, keeping Monday first and Sunday last", () => {
    expect(toggleDay([], 0)).toEqual([0]);
    expect(toggleDay([0, 3], 1)).toEqual([1, 3, 0]);
    expect(toggleDay([1, 3, 0], 3)).toEqual([1, 0]);
  });

  it("adds times without repeats, sorted, at most 12", () => {
    expect(addTime([], "09:00")).toEqual(["09:00"]);
    expect(addTime(["17:00"], "09:00")).toEqual(["09:00", "17:00"]);
    expect(addTime(["09:00"], "09:00")).toEqual(["09:00", "10:00"]);
    expect(addTime(["09:00"])).toEqual(["09:00", "10:00"]);
    expect(addTime([])).toEqual(["09:00"]);
    const twelve = Array.from({ length: 12 }, (_, i) => `${String(i + 8).padStart(2, "0")}:00`);
    expect(addTime(twelve)).toEqual(twelve);
  });

  it("changes and removes a time in place", () => {
    expect(setTimeAt(["09:00", "17:00"], 1, "18:30")).toEqual(["09:00", "18:30"]);
    expect(removeTimeAt(["09:00", "17:00"], 0)).toEqual(["17:00"]);
    expect(sortTimes(["17:00", "09:00", "17:00"])).toEqual(["09:00", "17:00"]);
  });
});

describe("scheduleProblem", () => {
  const ok = { enabled: true, days: [1], times: ["09:00"], catchUpMin: 30 };
  it.each<[string, Partial<typeof ok>, string]>([
    ["a good schedule", {}, ""],
    ["off keeps whatever it has", { enabled: false, days: [], times: [] }, ""],
    ["no day", { days: [] }, "Pick at least one day and one time"],
    ["no time", { times: [] }, "Pick at least one day and one time"],
    ["a bad time", { times: ["9:5"] }, "Use times like 09:30 (24 hour)"],
    ["24:00 isn't a time", { times: ["24:00"] }, "Use times like 09:30 (24 hour)"],
    ["a repeated time", { times: ["09:00", "09:00"] }, "Each time can be listed once"],
    ["too many times", { times: Array.from({ length: 13 }, (_, i) => `${String(i + 6).padStart(2, "0")}:00`) }, "At most 12 times"],
  ])("%s", (_n, patch, want) => {
    expect(scheduleProblem({ ...ok, ...patch })).toBe(want);
  });
});

describe("schedule text", () => {
  it("names day sets", () => {
    expect(daysText([0, 1, 2, 3, 4, 5, 6])).toBe("Every day");
    expect(daysText([1, 2, 3, 4, 5])).toBe("Weekdays");
    expect(daysText([6, 0])).toBe("Weekends");
    expect(daysText([3, 1])).toBe("Mon, Wed");
    expect(daysText([])).toBe("No days");
  });

  it("summarises an enabled schedule", () => {
    expect(scheduleSummary(scheduleOf({ enabled: true, days: [1, 2, 3, 4, 5], times: ["17:00", "09:30"], catchUpMin: 30 }))).toBe("Weekdays 09:30, 17:00");
    expect(scheduleSummary(scheduleOf({ enabled: true, days: [], times: [], catchUpMin: 30 }))).toBe("Schedule (not set up)");
    expect(scheduleSummary(scheduleOf({ enabled: false, days: [1], times: ["09:00"], catchUpMin: 30 }))).toBe("");
    expect(scheduleOf(null)).toEqual({ enabled: false, days: [], times: [], catchUpMin: 30 });
  });

  it("shows the next fire or the schedule's message on the list card", () => {
    const thu = new Date(2026, 10, 5, 9, 30).getTime(); // Thu 5 Nov 2026
    expect(nextFireText(thu)).toBe("Thu 09:30");
    expect(scheduleLine(true, { active: true, message: "", next: thu })).toBe("Next: Thu 09:30");
    expect(scheduleLine(true, { active: false, message: "Fix the problems in step 2", next: 0 })).toBe("Fix the problems in step 2");
    expect(scheduleLine(true, { active: true, message: "Skipped 9:30: the last run is still going", next: thu })).toBe("Skipped 9:30: the last run is still going");
    expect(scheduleLine(false, { active: true, message: "", next: thu })).toBe("");
    expect(scheduleLine(true, undefined)).toBe("");
  });
});

describe("time waits", () => {
  const at = (h: number, m: number, d = 5) => new Date(2026, 10, d, h, m).getTime();
  it("tells the clock and what's left", () => {
    expect(clockText(at(17, 30))).toBe("17:30");
    expect(clockText(0)).toBe("");
    expect(remainingText(at(17, 30), at(16, 48))).toBe("42 min");
    expect(remainingText(at(17, 30), at(16, 25))).toBe("1 h 05 min");
    expect(remainingText(at(17, 30), at(15, 30))).toBe("2 h");
    expect(remainingText(at(17, 30), at(17, 29, 5) + 30_000)).toBe("under a minute");
    expect(remainingText(0, 1)).toBe("");
  });

  it("writes the countdown line", () => {
    expect(timeWaitText(at(17, 30), at(16, 48))).toBe("Until 17:30 · 42 min");
    expect(timeWaitText(0, 1)).toBe("Waiting");
    expect(timeWaitText(at(9, 0, 6), at(22, 0))).toMatch(/^Until 09:00 \(Fri\) · 11 h$/);
  });

  it("recognises a waiting-on-the-clock cell", () => {
    expect(isTimeWait({ status: CellStatus.CellWaiting, wait: WaitKind.WaitTime })).toBe(true);
    expect(isTimeWait({ status: CellStatus.CellWaiting, wait: WaitKind.WaitManual })).toBe(false);
    expect(isTimeWait({ status: CellStatus.CellDone, wait: WaitKind.WaitTime })).toBe(false);
  });
});
