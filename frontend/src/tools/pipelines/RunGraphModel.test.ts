import { describe, expect, it } from "vitest";
import { CellStatus, WaitKind } from "@/lib/api";
import { normalizeRun } from "@/state/pipelines";
import { cell, file, item, run as mkRun } from "./RunGridFixtures";
import { filesText, needsYouSteps, runGraph, runWireState, statsText, stepCells, stepProgress, stepStats } from "./RunGraphModel";
import { step } from "./testFixtures";

const steps = [step("s1", "stems"), step("s2", "trimmer", { from: "s1" })];

function build() {
  return normalizeRun(
    mkRun("r", {
      steps,
      items: [
        item(0, "a.mp3", [cell("s1", CellStatus.CellDone, { files: [file("/o/a1.wav"), file("/o/a2.wav")] }), cell("s2", CellStatus.CellRunning)]),
        item(1, "b.mp3", [cell("s1", CellStatus.CellDone, { files: [file("/o/b1.wav")] }), cell("s2", CellStatus.CellWaiting, { wait: WaitKind.WaitManual })]),
        item(2, "c.mp3", [cell("s1", CellStatus.CellFailed, { error: "\nStem model missing\nsecond line" }), cell("s2", CellStatus.CellBlocked)]),
        item(3, "d.mp3", [cell("s1", CellStatus.CellSkipped), cell("s2", CellStatus.CellPending)]),
      ],
    }),
  );
}

describe("stepStats", () => {
  it("counts done, running, waiting, needs you, failed and skipped per step", () => {
    const r = build();
    expect(stepStats(r, "s1")).toMatchObject({ done: 2, failed: 1, skipped: 1, running: 0, needsYou: 0, files: 3, error: "Stem model missing" });
    expect(stepStats(r, "s2")).toMatchObject({ running: 1, needsYou: 1, failed: 1, pending: 1, done: 0, files: 0, error: "" });
  });

  it("reads a plain wait as waiting, not needs you", () => {
    const r = normalizeRun(mkRun("r", { steps, items: [item(0, "a", [cell("s1", CellStatus.CellDone), cell("s2", CellStatus.CellWaiting, { wait: WaitKind.WaitCondition })])] }));
    expect(stepStats(r, "s2")).toMatchObject({ waiting: 1, needsYou: 0 });
  });

  it("describes the counts", () => {
    const r = build();
    expect(statsText(stepStats(r, "s1"))).toBe("2 done · 1 failed · 1 skipped");
    expect(statsText(stepStats(r, "s2"))).toBe("1 need you · 1 running · 1 failed");
    expect(filesText(1)).toBe("1 file");
    expect(filesText(3)).toBe("3 files");
    expect(filesText(0)).toBe("");
  });

  it("finds the steps that wait for the user", () => {
    expect(needsYouSteps(build())).toEqual(["s2"]);
  });
});

describe("stepProgress", () => {
  it("averages the running cells, and is unknown when one is", () => {
    const r = normalizeRun(mkRun("r", { steps, items: [item(0, "a", [cell("s1", CellStatus.CellRunning)]), item(1, "b", [cell("s1", CellStatus.CellRunning)])] }));
    const prog = [0.2, 0.6];
    let i = 0;
    expect(stepProgress(r, "s1", () => prog[i++] ?? 0)).toBeCloseTo(0.4);
    expect(stepProgress(r, "s1", () => -1)).toBe(-1);
    expect(stepProgress(r, "s2", () => 0.5)).toBe(-1);
  });
});

describe("runWireState", () => {
  const z = { pending: 0, running: 0, waiting: 0, needsYou: 0, done: 0, failed: 0, skipped: 0, files: 0, error: "" };
  it("flows into a working step, glows when done, fails, and dims before anything passed", () => {
    expect(runWireState(z, { ...z, running: 1 })).toBe("flow");
    expect(runWireState(z, { ...z, needsYou: 1 })).toBe("flow");
    expect(runWireState({ ...z, done: 1 }, { ...z, done: 2 })).toBe("done");
    expect(runWireState({ ...z, done: 1 }, { ...z, failed: 1 })).toBe("failed");
    expect(runWireState(z, { ...z, pending: 2 })).toBe("dim");
    expect(runWireState(undefined, { ...z, pending: 2 })).toBe("idle");
    expect(runWireState({ ...z, done: 1 }, { ...z, pending: 2 })).toBe("idle");
  });
});

describe("stepCells", () => {
  it("lists a step's cells per item and leaves out those that don't apply", () => {
    const r = normalizeRun(
      mkRun("r", { steps, items: [item(0, "a", [cell("s1", CellStatus.CellDone), cell("s2", CellStatus.CellNone)]), item(1, "b", [cell("s1", CellStatus.CellDone), cell("s2", CellStatus.CellPending)])] }),
    );
    expect(stepCells(r, "s1").map((c) => c.item.label)).toEqual(["a", "b"]);
    expect(stepCells(r, "s2").map((c) => c.item.label)).toEqual(["b"]);
  });
});

describe("runGraph", () => {
  it("lays steps out in columns by depth with room for the run block", () => {
    const g = runGraph(steps);
    const x = (id: string) => g.nodes.find((n) => n.id === id)?.x ?? -1;
    expect(x("input")).toBeLessThan(x("s1"));
    expect(x("s1")).toBeLessThan(x("s2"));
    expect(g.wires.map((w) => `${w.from}>${w.to}`)).toEqual(["input>s1", "s1>s2"]);
    const same = runGraph([step("a", "stems"), step("b", "stems")]);
    const na = same.nodes.find((n) => n.id === "a");
    const nb = same.nodes.find((n) => n.id === "b");
    expect((nb?.y ?? 0) - (na?.y ?? 0)).toBeGreaterThanOrEqual(na?.h ?? 0);
  });
});

describe("wrapRunGraph", () => {
  it("wraps a long chain into rows when it doesn't fit at a readable zoom, and leaves short ones alone", async () => {
    const { wrapRunGraph } = await import("./RunGraphModel");
    const node = (id: string, col: number) => ({ id, type: "step" as const, x: col * 260, y: 0, w: 200, h: 100, ports: [], params: [], values: [], more: null });
    const g = { wires: [], nodes: [0, 1, 2, 3, 4].map((c) => node(`n${c}`, c)) };
    const wide = wrapRunGraph(g, 2000);
    expect(wide).toBe(g);
    const narrow = wrapRunGraph(g, 700);
    const rows = new Set(narrow.nodes.map((n) => n.y));
    expect(rows.size).toBeGreaterThan(1);
    expect(Math.max(...narrow.nodes.map((n) => n.x + n.w)) * 0.85).toBeLessThanOrEqual(700);
  });
});
