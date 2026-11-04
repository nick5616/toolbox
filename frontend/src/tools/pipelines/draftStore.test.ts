import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ save: vi.fn(), describe: vi.fn() }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    PipelinesService: { Save: (...a: unknown[]) => h.save(...a), Describe: (...a: unknown[]) => h.describe(...a) },
    FilesService: { PickFolder: async () => "C:/Inbox" },
  };
});

import type { Pipeline, StepType } from "@/lib/api";
import { usePipelines } from "@/state/pipelines";
import { SAVE_DELAY_MS, useDraft } from "./draftStore";
import { stepsOf } from "./editorModel";
import { serializeLayout } from "./graphModel";
import { CATALOG, check, entry, pipeline, step, stepCheck } from "./testFixtures";

const A = "aaaaaaaa";
const B = "bbbbbbbb";
const C = "cccccccc";

const base = () => pipeline("p1", [step(A, "downloader"), step(B, "stems", { from: A }), step(C, "trimmer", { from: B })]);
const ids = (p: Pipeline | null) => stepsOf(p ?? pipeline("x", [])).map((s) => s.id);
const draft = () => useDraft.getState().draft!;

beforeEach(() => {
  vi.useFakeTimers();
  h.save.mockImplementation(async (p: Pipeline) => entry(p));
  h.describe.mockImplementation(async (p: Pipeline) => check(stepsOf(p).map((s) => stepCheck(s.id))));
  usePipelines.setState({ entries: [entry(base())], catalog: CATALOG, runs: {}, loaded: true, selectedPipelineId: "p1" });
  useDraft.getState().open(entry(base()));
});

afterEach(() => {
  useDraft.getState().close();
  vi.useRealTimers();
  vi.clearAllMocks();
});

type Op = { name: string; run: () => void; check: (p: Pipeline) => void };

describe("draftStore undo and redo", () => {
  const ops: Op[] = [
    { name: "rename", run: () => useDraft.getState().setName("Renamed"), check: (p) => expect(p.name).toBe("Renamed") },
    {
      name: "add a step",
      run: () => useDraft.getState().edit((p) => ({ ...p, steps: [...stepsOf(p), step("dddddddd", "pdf", { from: "none" })] })),
      check: (p) => expect(ids(p)).toEqual([A, B, C, "dddddddd"]),
    },
    { name: "patch a step", run: () => useDraft.getState().patchStep(B, { label: "Splitter" }), check: (p) => expect(stepsOf(p)[1]?.label).toBe("Splitter") },
    { name: "move a node", run: () => useDraft.getState().editLayout(serializeLayout({ v: 1, nodes: { [A]: { x: 5, y: 6 } }, view: { x: 0, y: 0, zoom: 1 } }, [A]), true), check: (p) => expect(p.layout).toContain('"x":5') },
    { name: "delete a node", run: () => useDraft.getState().removeStep(C), check: (p) => expect(ids(p)).not.toContain(C) },
    { name: "duplicate a node", run: () => useDraft.getState().duplicateStep(A), check: (p) => expect(stepsOf(p).length).toBeGreaterThan(3) },
    { name: "watch a folder", run: () => useDraft.getState().setWatchEnabled(true), check: (p) => expect(p.watch.enabled).toBe(true) },
  ];

  it("steps back and forward through a sequence of graph and list edits", () => {
    const snapshots: Pipeline[] = [draft()];
    for (const op of ops) {
      // Spaced out so nothing coalesces.
      vi.setSystemTime(Date.now() + 5000);
      op.run();
      op.check(draft());
      snapshots.push(draft());
    }
    expect(useDraft.getState().canUndo).toBe(true);
    expect(useDraft.getState().canRedo).toBe(false);
    for (let i = ops.length - 1; i >= 0; i--) {
      useDraft.getState().undo();
      expect(draft()).toEqual(snapshots[i]);
    }
    expect(useDraft.getState().canUndo).toBe(false);
    useDraft.getState().undo(); // nothing left: no-op
    expect(draft()).toEqual(snapshots[0]);
    for (let i = 1; i <= ops.length; i++) {
      useDraft.getState().redo();
      expect(draft()).toEqual(snapshots[i]);
    }
    expect(useDraft.getState().canRedo).toBe(false);
  });

  it("a new edit after undo drops the redo branch", () => {
    useDraft.getState().setName("One");
    vi.setSystemTime(Date.now() + 5000);
    useDraft.getState().setName("Two");
    useDraft.getState().undo();
    expect(draft().name).toBe("One");
    vi.setSystemTime(Date.now() + 5000);
    useDraft.getState().setDescription("d");
    expect(useDraft.getState().canRedo).toBe(false);
  });

  it("typing in one field is one undo step", () => {
    for (const n of ["N", "Ne", "New"]) useDraft.getState().setName(n);
    expect(draft().name).toBe("New");
    useDraft.getState().undo();
    expect(draft().name).toBe(base().name);
    expect(useDraft.getState().canUndo).toBe(false);
  });

  it("pan and zoom are saved but not undoable", () => {
    useDraft.getState().editLayout('{"v":1,"nodes":{},"view":{"x":9,"y":9,"zoom":1}}', false);
    expect(useDraft.getState().canUndo).toBe(false);
    expect(useDraft.getState().dirty).toBe(true);
  });

  it("undo saves the restored draft and re-checks it", async () => {
    useDraft.getState().setName("Changed");
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 50);
    expect(h.save).toHaveBeenCalledTimes(1);
    useDraft.getState().undo();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 50);
    expect(h.save).toHaveBeenCalledTimes(2);
    expect((h.save.mock.calls[1]![0] as Pipeline).name).toBe(base().name);
    expect(h.describe).toHaveBeenCalled();
  });

  it("clears the selected step when undo removes it", () => {
    vi.setSystemTime(Date.now() + 5000);
    useDraft.getState().edit((p) => ({ ...p, steps: [...stepsOf(p), step("dddddddd", "pdf", { from: "none" })] }));
    useDraft.getState().select("dddddddd");
    useDraft.getState().undo();
    expect(useDraft.getState().stepId).toBeNull();
  });

  it("keeps at least one step", () => {
    useDraft.getState().edit((p) => ({ ...p, steps: [step(A, "downloader")] }));
    useDraft.getState().removeStep(A);
    expect(ids(draft())).toEqual([A]);
  });
});

describe("draftStore catalog type", () => {
  it("is JSON-serialisable for the bridge", () => {
    const t: StepType[] = CATALOG;
    expect(JSON.parse(JSON.stringify(t))).toEqual(t);
  });
});
