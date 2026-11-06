import { describe, expect, it } from "vitest";
import { CellStatus } from "@/lib/api";
import { normalizeRun } from "@/state/pipelines";
import { cell, item, run } from "./RunGridFixtures";
import { runProgressText } from "./RunGridModel";

describe("runProgressText", () => {
  it("counts files for a run with inputs", () => {
    const r = normalizeRun(run("r", { inputs: ["a.mp3", "b.mp3"], items: [item(0, "a", [cell("s", CellStatus.CellDone)]), item(1, "b", [cell("s", CellStatus.CellRunning)])] }));
    expect(runProgressText(r)).toBe("1 of 2 files");
  });
  it("counts steps for a run without files", () => {
    const r = normalizeRun(run("r", { inputs: [], items: [item(0, "Pomodoro", [cell("a", CellStatus.CellDone), cell("b", CellStatus.CellSkipped), cell("c", CellStatus.CellWaiting)], { input: "" })] }));
    expect(runProgressText(r)).toBe("2 of 3 steps");
  });
});
