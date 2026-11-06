import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ save: vi.fn(), start: vi.fn(), cont: vi.fn(), list: vi.fn() }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    PipelinesService: {
      Save: (...a: unknown[]) => h.save(...a),
      Start: (...a: unknown[]) => h.start(...a),
      Continue: (...a: unknown[]) => h.cont(...a),
      Describe: async () => ({}),
      List: (...a: unknown[]) => h.list(...a),
      Runs: async () => [],
      Catalog: async () => [],
      Templates: async () => [],
    },
    FilesService: { PickFolder: async () => "" },
  };
});

import { CellStatus, WaitKind } from "@/lib/api";
import { cellLook } from "./RunGridModel";
import { usePipelines } from "@/state/pipelines";
import { useDraft } from "./draftStore";
import { PipelineList } from "./PipelineList";
import { TriggersPanel, triggersSummary } from "./panels";
import { RunSheet } from "./RunSheet";
import { runWithoutFiles, needsRunSheet, startsWithoutFiles } from "./runNoFiles";
import { cell, item, run } from "./RunGridFixtures";
import { scheduleOf } from "./scheduleModel";
import { TimeWaitCard } from "./TimeWaitCard";
import { check, entry, pipeline, step } from "./testFixtures";
import { normalizeRun } from "@/state/pipelines";

const p = () => pipeline("p1", [step("aaaaaaaa", "downloader")]);

function openDraft(schedule: Partial<ReturnType<typeof scheduleOf>> = {}, status = { active: false, message: "", next: 0 }, takesFiles = false) {
  const pl = p();
  pl.schedule = { enabled: false, days: [], times: [], catchUpMin: 30, ...schedule };
  useDraft.getState().open(entry(pl, check([], { takesFiles })));
  useDraft.getState().setLive({ scheduleStatus: status });
}
const sched = () => useDraft.getState().draft!.schedule;

beforeEach(() => {
  h.save.mockReset().mockImplementation(async (pl: unknown) => entry(pl as never));
  h.start.mockReset().mockResolvedValue(runView("r1"));
  h.list.mockReset().mockResolvedValue([]);
  h.cont.mockReset().mockResolvedValue(undefined);
  usePipelines.setState({ entries: [], runs: {}, runSheet: null, selectedRunId: null });
});
afterEach(() => {
  cleanup();
  useDraft.getState().markDeleted();
  useDraft.getState().close();
});

function runView(id: string, trigger = "manual") {
  return normalizeRun(run(id, { trigger }));
}

describe("the schedule editor", () => {
  it("is off by default and shows only its switch", () => {
    openDraft();
    render(<TriggersPanel />);
    expect(screen.getByRole("switch", { name: "Run on a schedule" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("group", { name: "Days" })).toBeNull();
  });

  it("turning it on starts with weekdays at 09:00", async () => {
    openDraft();
    render(<TriggersPanel />);
    await userEvent.click(screen.getByRole("switch", { name: "Run on a schedule" }));
    expect(sched()).toMatchObject({ enabled: true, days: [1, 2, 3, 4, 5], times: ["09:00"], catchUpMin: 30 });
    expect(screen.getByRole("button", { name: "Monday" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Saturday" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("day chips and the shortcuts change the days", async () => {
    openDraft({ enabled: true, days: [1], times: ["09:00"] });
    render(<TriggersPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Sunday" }));
    expect(sched().days).toEqual([1, 0]);
    await userEvent.click(screen.getByRole("button", { name: "Every day" }));
    expect(sched().days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    await userEvent.click(screen.getByRole("button", { name: "Weekdays" }));
    expect(sched().days).toEqual([1, 2, 3, 4, 5]);
  });

  it("adds, edits and removes times", async () => {
    openDraft({ enabled: true, days: [1], times: ["09:00"] });
    render(<TriggersPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Add time" }));
    expect(sched().times).toEqual(["09:00", "10:00"]);
    await userEvent.click(screen.getByRole("button", { name: "Remove time 1" }));
    expect(sched().times).toEqual(["10:00"]);
  });

  it("sets the catch-up window", async () => {
    openDraft({ enabled: true, days: [1], times: ["09:00"] });
    render(<TriggersPanel />);
    await userEvent.selectOptions(screen.getByLabelText("Catch up within"), "120");
    expect(sched().catchUpMin).toBe(120);
  });

  it("says what is missing instead of saving an empty schedule silently", async () => {
    openDraft({ enabled: true, days: [1], times: ["09:00"] });
    render(<TriggersPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Monday" }));
    expect(screen.getByRole("alert").textContent).toBe("Pick at least one day and one time");
  });

  it("shows the schedule's own message, and warns when a step reads the run's files", () => {
    openDraft({ enabled: true, days: [1], times: ["09:00"] }, { active: false, message: "Fix the problems in step 2", next: 0 });
    render(<TriggersPanel />);
    expect(screen.getByText("Fix the problems in step 2")).toBeTruthy();
    cleanup();
    useDraft.getState().close();
    openDraft({ enabled: true, days: [1], times: ["09:00"] }, { active: false, message: "", next: 0 }, true);
    render(<TriggersPanel />);
    expect(screen.getByText(/starts with no files/)).toBeTruthy();
  });

  it("is part of the Triggers summary", () => {
    expect(triggersSummary("", false, { enabled: false, kinds: [] }, scheduleOf({ enabled: true, days: [1, 2, 3, 4, 5], times: ["09:30"], catchUpMin: 30 }))).toBe("Weekdays 09:30");
    expect(triggersSummary("", false, { enabled: false, kinds: [] }, scheduleOf(null))).toBe("Off");
  });
});

describe("runs without files", () => {
  it("knows which pipelines start without files", () => {
    expect(startsWithoutFiles(entry(p(), check([], { takesFiles: false })))).toBe(true);
    expect(startsWithoutFiles(entry(p(), check([], { takesFiles: true })))).toBe(false);
    expect(startsWithoutFiles(undefined)).toBe(false);
  });

  it("starts at once with no inputs when nothing needs asking", async () => {
    await runWithoutFiles(entry(p(), check([], { takesFiles: false })));
    expect(h.start).toHaveBeenCalledWith({ pipelineId: "p1", inputs: [], secrets: {}, params: {} });
    expect(usePipelines.getState().selectedRunId).toBe("r1");
    expect(usePipelines.getState().runSheet).toBeNull();
  });

  it("opens the sheet first when there are run parameters or passwords", async () => {
    const pl = p();
    pl.params = [{ name: "n", label: "N", type: "number", default: "1", choices: [] } as never];
    const e = entry(pl, check([], { takesFiles: false }));
    expect(needsRunSheet(e)).toBe(true);
    await runWithoutFiles(e);
    expect(h.start).not.toHaveBeenCalled();
    expect(usePipelines.getState().runSheet?.pipelineId).toBe("p1");
  });

  it("the list card has a Run button that starts it", async () => {
    usePipelines.setState({ entries: [entry(p(), check([], { takesFiles: false }))], loaded: true, selectedPipelineId: "p1" });
    render(<PipelineList onNew={() => undefined} />);
    expect(screen.getByText("Takes no files")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Run Pipeline p1" }));
    await waitFor(() => expect(h.start).toHaveBeenCalledWith(expect.objectContaining({ inputs: [] })));
  });

  it("the card of a pipeline that takes files still opens the Run sheet", async () => {
    usePipelines.setState({ entries: [entry(p(), check([], { takesFiles: true }))], loaded: true, selectedPipelineId: "p1" });
    render(<PipelineList onNew={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "Run Pipeline p1" }));
    expect(h.start).not.toHaveBeenCalled();
    expect(usePipelines.getState().runSheet?.pipelineId).toBe("p1");
  });

  it("the card shows the next scheduled run or the schedule's message", () => {
    const next = new Date(2026, 10, 5, 9, 30).getTime();
    const pl = p();
    pl.schedule = { enabled: true, days: [4], times: ["09:30"], catchUpMin: 30 };
    usePipelines.setState({ entries: [entry(pl, check([], { takesFiles: false }), { schedule: { active: true, message: "", next } })], loaded: true, selectedPipelineId: "p1" });
    const { unmount } = render(<PipelineList onNew={() => undefined} />);
    expect(screen.getByText("Next: Thu 09:30")).toBeTruthy();
    unmount();
    usePipelines.setState({ entries: [entry(pl, check([], { takesFiles: false }), { schedule: { active: false, message: "Fix the problems in step 1", next: 0 } })] });
    render(<PipelineList onNew={() => undefined} />);
    expect(screen.getByText("Fix the problems in step 1")).toBeTruthy();
  });

  it("refetches the list every minute while a schedule is on", async () => {
    vi.useFakeTimers();
    try {
      const pl = p();
      pl.schedule = { enabled: true, days: [4], times: ["09:30"], catchUpMin: 30 };
      usePipelines.setState({ entries: [entry(pl, check([], { takesFiles: false }))], loaded: true, selectedPipelineId: "p1" });
      render(<PipelineList onNew={() => undefined} />);
      expect(h.list).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.list).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the Run sheet of a no-files pipeline has no drop zone and starts without inputs", async () => {
    usePipelines.setState({ entries: [entry(p(), check([], { takesFiles: false }))], loaded: true, runSheet: { pipelineId: "p1", inputs: [] } });
    render(<RunSheet pipelineId="p1" />);
    expect(screen.queryByText("Drop files here")).toBeNull();
    expect(screen.getByText("Starts without files.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(h.start).toHaveBeenCalledWith({ pipelineId: "p1", inputs: [], secrets: {}, params: {} });
  });
});

describe("a time-waiting cell", () => {
  const until = Date.now() + 42 * 60_000 + 20_000;
  const waiting = () => {
    const r = runView("r1");
    const c = { ...cell("aaaaaaaa", CellStatus.CellWaiting, { wait: WaitKind.WaitTime, until, message: "Focus until 17:30" }), jobIds: [], inputs: [], files: [] };
    const entryItem = { ...item(0, "Morning", []), cells: [c], merged: [], vars: {} };
    return { r, entryItem, c };
  };

  it("shows the countdown and a Continue now button", async () => {
    const { r, entryItem, c } = waiting();
    render(<TimeWaitCard run={r} item={entryItem} cell={c} />);
    expect(screen.getByTestId("time-wait").textContent).toMatch(/^Until \d\d:\d\d( \(\w+\))? · 4[23] min$/);
    expect(screen.getByText("Focus until 17:30")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Continue now" }));
    expect(h.cont).toHaveBeenCalledWith({ runId: "r1", item: 0, stepId: "aaaaaaaa", keep: null, passThrough: false });
  });

  it("the grid's cell look names the moment", () => {
    const { c } = waiting();
    expect(cellLook(c)).toMatchObject({ icon: "timer", tone: "warn", label: expect.stringMatching(/^Until \d\d:\d\d$/) });
  });
});
