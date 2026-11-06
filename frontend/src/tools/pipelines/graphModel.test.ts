import { describe, expect, it } from "vitest";
import { CellStatus, RunStatus, WaitKind, type PipelineStep } from "@/lib/api";
import type { RunView } from "@/state/pipelines";
import {
  ALL_PORT,
  buildGraph,
  connect,
  connectReason,
  countsText,
  deleteSteps,
  disconnect,
  duplicateSteps,
  INPUT_NODE,
  parseLayout,
  serializeLayout,
  stepRunCounts,
  topoSort,
  wireRunState,
} from "./graphModel";
import { CATALOG, check, product, step, stepCheck } from "./testFixtures";

const A = "aaaaaaaa";
const B = "bbbbbbbb";
const C = "cccccccc";
const D = "dddddddd";

const chk = (steps: PipelineStep[]) =>
  check([
    stepCheck(A, {}, [product("", [".mp4"], "Video")]),
    stepCheck(B, {}, [product("vocals", [".mp3"], "Vocals"), product("drums", [".mp3"], "Drums")]),
    ...steps.slice(2).map((s) => stepCheck(s.id)),
  ]);

const chain = () => [step(A, "downloader", { from: "input" }), step(B, "stems", { from: "input" }), step(C, "trimmer", { from: "none" })];

describe("layout JSON", () => {
  it("tolerates empty, bad and partial JSON", () => {
    for (const bad of ["", "   ", "{", "null", "[]", '{"nodes":5}', '{"v":1,"nodes":{"a":{"x":"1","y":2}}}']) {
      const l = parseLayout(bad);
      expect(l.nodes).toEqual({});
      expect(l.view.zoom).toBe(1);
    }
  });

  it("round-trips positions and the view, dropping unknown nodes", () => {
    const json = serializeLayout({ v: 1, nodes: { a: { x: 10.123, y: 20 }, gone: { x: 1, y: 1 } }, view: { x: 5, y: 6, zoom: 0.5 } }, ["a"]);
    const back = parseLayout(json);
    expect(back.nodes).toEqual({ a: { x: 10.1, y: 20 } });
    expect(back.view).toEqual({ x: 5, y: 6, zoom: 0.5 });
    expect(json.length).toBeLessThan(32 << 10);
  });

  it("clamps the zoom", () => {
    expect(parseLayout('{"view":{"x":0,"y":0,"zoom":99}}').view.zoom).toBe(2);
    expect(parseLayout('{"view":{"x":0,"y":0,"zoom":0}}').view.zoom).toBe(0.3);
  });
});

describe("buildGraph", () => {
  it("makes an input node, step nodes, ports per role and wires from `from` and the role filter", () => {
    const steps = [step(A, "downloader"), step(B, "stems", { from: A }), step(C, "trimmer", { from: B, filter: { roles: ["vocals"], kinds: [], exts: [], name: "" } })];
    const g = buildGraph(steps, chk(steps), parseLayout(""));
    expect(g.nodes.map((n) => n.id)).toEqual([INPUT_NODE, A, B, C]);
    expect(g.nodes.find((n) => n.id === B)?.ports.map((p) => p.id)).toEqual([ALL_PORT, "vocals", "drums"]);
    expect(g.wires.map((w) => [w.from, w.port, w.to])).toEqual([
      [INPUT_NODE, ALL_PORT, A],
      [A, ALL_PORT, B],
      [B, "vocals", C],
    ]);
    expect(g.wires[2]?.kind).toBe("audio");
  });

  it("lays columns out left to right by depth and keeps saved positions", () => {
    const steps = [step(A, "downloader"), step(B, "stems", { from: A })];
    const g = buildGraph(steps, undefined, parseLayout(JSON.stringify({ nodes: { [B]: { x: 7, y: 9 } } })));
    const x = (id: string) => g.nodes.find((n) => n.id === id)?.x ?? NaN;
    expect(x(INPUT_NODE)).toBeLessThan(x(A));
    expect(g.nodes.find((n) => n.id === B)).toMatchObject({ x: 7, y: 9 });
  });

  it("leaves unwired steps without a wire", () => {
    const g = buildGraph([step(A, "downloader", { from: "none" })], undefined, parseLayout(""));
    expect(g.wires).toEqual([]);
  });

  it("shows several list-set roles as one wire from the all port", () => {
    const steps = [step(B, "stems"), step(C, "trimmer", { from: B, filter: { roles: ["vocals", "drums"], kinds: [], exts: [], name: "" } })];
    const w = buildGraph(steps, undefined, parseLayout("")).wires.find((x) => x.to === C);
    expect(w?.port).toBe(ALL_PORT);
    expect(w?.roles).toEqual(["vocals", "drums"]);
  });
});

describe("connect", () => {
  it("sets from and the role filter, keeps the other filter fields and replaces the old wire", () => {
    const steps = chain().map((s) => (s.id === C ? { ...s, filter: { roles: [], kinds: [], exts: [".mp4"], name: "" } } : s));
    const res = connect(steps, chk(steps), CATALOG, A, ALL_PORT, C);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.steps.find((s) => s.id === C)).toMatchObject({ from: A, filter: { roles: [], exts: [".mp4"] } });
    const again = connect(res.steps, chk(res.steps), CATALOG, INPUT_NODE, ALL_PORT, C);
    expect(again.ok && again.steps.find((s) => s.id === C)?.from).toBe("input");
  });

  it("turns Keep off on the source unless the user set it", () => {
    const steps = chain().map((s) => ({ ...s, keep: true }));
    const r1 = connect(steps, chk(steps), CATALOG, A, ALL_PORT, C);
    expect(r1.ok && r1.steps.find((s) => s.id === A)?.keep).toBe(false);
    const r2 = connect(steps, chk(steps), CATALOG, A, ALL_PORT, C, new Set([A]));
    expect(r2.ok && r2.steps.find((s) => s.id === A)?.keep).toBe(true);
  });

  it("wires a role port as a one-role filter", () => {
    const steps = chain();
    const res = connect(steps, chk(steps), CATALOG, B, "vocals", A);
    // downloader reads links only, but a role port of stems makes audio: refused
    expect(res.ok).toBe(false);
    const stems2 = [...steps, step(D, "stems", { from: "none" })];
    const ok = connect(stems2, chk(stems2), CATALOG, B, "vocals", D);
    expect(ok.ok && ok.steps.find((s) => s.id === D)?.filter.roles).toEqual(["vocals"]);
  });

  it("refuses kinds the target can't read, with the reason", () => {
    const steps = chain();
    // stems make audio; the trimmer reads only .mp4
    expect(connectReason(steps, chk(steps), CATALOG, B, ALL_PORT, C)).toMatch(/Video Trimmer reads video; .*makes audio/);
    // the first step makes video: fine
    expect(connectReason(steps, chk(steps), CATALOG, A, ALL_PORT, C)).toBe("");
  });

  it("refuses loops and self wires", () => {
    const steps = [step(A, "stems", { from: "input" }), step(B, "stems", { from: A }), step(C, "stems", { from: B })];
    const c = check(steps.map((s) => stepCheck(s.id, {}, [product("", [".mp3"])])));
    expect(connectReason(steps, c, CATALOG, C, ALL_PORT, A)).toMatch(/loop/);
    expect(connectReason(steps, c, CATALOG, B, ALL_PORT, B)).toMatch(/own files/);
    expect(connect(steps, c, CATALOG, C, ALL_PORT, A).ok).toBe(false);
  });

  it("always allows the input, any-readers, check and chat", () => {
    const steps = [step(A, "stems"), step(B, "pipelines.check", { from: "none" }), step(C, "llm-chat", { from: "none" })];
    const c = check(steps.map((s) => stepCheck(s.id, {}, [product("", [".mp3"])])));
    expect(connectReason(steps, c, CATALOG, INPUT_NODE, ALL_PORT, A)).toBe("");
    expect(connectReason(steps, c, CATALOG, A, ALL_PORT, B)).toBe("");
    expect(connectReason(steps, c, CATALOG, A, ALL_PORT, C)).toBe("");
  });

  it("is soft when Describe hasn't answered yet", () => {
    const steps = chain();
    expect(connectReason(steps, undefined, CATALOG, B, ALL_PORT, C)).toBe("");
  });

  it("saves steps in topological order after wiring an earlier step to a later source", () => {
    // C is first in the list; wiring B (later) into C moves C after B.
    const steps = [step(C, "stems", { from: "none" }), step(A, "downloader"), step(B, "stems", { from: A })];
    const c = check(steps.map((s) => stepCheck(s.id, {}, [product("", [".mp3"])])));
    const res = connect(steps, c, CATALOG, B, ALL_PORT, C);
    expect(res.ok && res.steps.map((s) => s.id)).toEqual([A, B, C]);
  });
});

describe("topoSort", () => {
  it("is stable when already ordered", () => {
    const steps = chain();
    expect(topoSort(steps).map((s) => s.id)).toEqual([A, B, C]);
  });

  it("puts sources first and keeps the rest in order", () => {
    const steps = [step(D, "x", { from: C }), step(C, "x", { from: A }), step(B, "x", { from: "input" }), step(A, "x", { from: "input" })];
    expect(topoSort(steps).map((s) => s.id)).toEqual([B, A, C, D]);
  });

  it("cuts a cycle instead of looping", () => {
    const out = topoSort([step(A, "x", { from: B }), step(B, "x", { from: A })]);
    expect(out.map((s) => s.from)).toEqual(["none", "none"]);
  });
});

describe("editing", () => {
  it("disconnect leaves the step unwired and clears its roles", () => {
    const steps = [step(A, "downloader"), step(B, "stems", { from: A, filter: { roles: ["x"], kinds: [], exts: [], name: "" } })];
    expect(disconnect(steps, B).find((s) => s.id === B)).toMatchObject({ from: "none", filter: { roles: [] } });
  });

  it("deleting a step unwires what read it", () => {
    const steps = chain().map((s) => (s.id === B ? { ...s, from: A } : s));
    const out = deleteSteps(steps, new Set([A]));
    expect(out.map((s) => s.id)).toEqual([B, C]);
    expect(out[0]?.from).toBe("none");
  });

  it("duplicates steps with new ids, reading what the original read", () => {
    const steps = [step(A, "downloader"), step(B, "stems", { from: A })];
    let n = 0;
    const res = duplicateSteps(steps, new Set([B]), () => `new0000${n++}`);
    expect(res.steps).toHaveLength(3);
    const copy = res.steps.find((s) => s.id === res.idMap.get(B));
    expect(copy).toMatchObject({ type: "stems", from: A });
  });

  it("a copy of two chained steps reads the other copy", () => {
    const steps = [step(A, "downloader"), step(B, "stems", { from: A })];
    let n = 0;
    const res = duplicateSteps(steps, new Set([A, B]), () => `new0000${n++}`);
    const a2 = res.idMap.get(A);
    const b2 = res.idMap.get(B);
    expect(res.steps.find((s) => s.id === b2)?.from).toBe(a2);
  });
});

describe("run status", () => {
  const cell = (stepId: string, status: CellStatus, wait: WaitKind | "" = "") => ({
    stepId, status, wait: wait as WaitKind, jobIds: [], inputs: [], files: [], message: "", errorCode: "" as never, error: "", errorHint: "", startedAt: 0, finishedAt: 0,
  });
  const run = (cells: ReturnType<typeof cell>[][]): RunView =>
    ({
      id: "r", pipelineId: "p", name: "", steps: [], status: RunStatus.RunRunning, trigger: "manual", inputs: [], needsYou: 0, error: "", cleaned: false, createdAt: 0, finishedAt: 0,
      items: cells.map((cs, i) => ({ index: i, label: "", input: "", merged: [], mergedAt: "", cells: cs, vars: {} })),
    }) as unknown as RunView;

  it("counts cells per step and names the wire state", () => {
    const r = run([
      [cell(A, CellStatus.CellDone), cell(B, CellStatus.CellRunning)],
      [cell(A, CellStatus.CellDone), cell(B, CellStatus.CellWaiting, WaitKind.WaitManual)],
      [cell(A, CellStatus.CellDone), cell(B, CellStatus.CellPending)],
    ]);
    const a = stepRunCounts([r], A);
    const b = stepRunCounts([r], B);
    expect(a.done).toBe(3);
    expect(b).toMatchObject({ running: 1, needsYou: 1, pending: 1 });
    expect(wireRunState(a)).toBe("done");
    expect(wireRunState(b)).toBe("flow");
    expect(countsText(b)).toBe("1 need you · 1 running · 1 pending");
  });

  it("failed beats everything and no run is idle", () => {
    const r = run([[cell(A, CellStatus.CellFailed)], [cell(A, CellStatus.CellRunning)]]);
    expect(wireRunState(stepRunCounts([r], A))).toBe("failed");
    expect(wireRunState(stepRunCounts([], A))).toBe("idle");
  });
});
