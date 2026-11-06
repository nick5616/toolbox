import { describe, expect, it } from "vitest";
import { ValueType as WireType, type PipelineStep } from "@/lib/api";
import { registerSteps, type StepUI } from "@/pipelines/steps/registry";
import {
  BODY_TOP,
  buildGraph,
  connectValue,
  HEAD_H,
  inPortPos,
  INPUT_NODE,
  moreRowIndex,
  NODE_W,
  NODE_W_WIDE,
  paramPortPos,
  parseLayout,
  PORT_H,
  serializeLayout,
  SUMMARY_H,
  valueConnectReason,
  valueOutPos,
  wiredPortsByNode,
} from "./graphModel";
import { askAtStart, bindCount, stepParams, unbindValue, unbindVar } from "./wiring";
import { check, pipeline, step, stepCheck, stepType } from "./testFixtures";
import { runGraph } from "./RunGraphModel";

const A = "aaaaaaaa";
const B = "bbbbbbbb";
const C = "cccccccc";

const SPIN_DEFAULTS = '{"speed":1,"title":"Hi","loud":false,"tint":"#112233","mode":"a","extra":3,"deep":{"level":2}}';
registerSteps([
  {
    type: "spin",
    parse: (j: string) => JSON.parse(j) as unknown,
    Editor: () => null,
    params: { "/mode": { type: "choice", choices: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }], primary: true }, "/speed": { primary: true, label: "Speed" } },
  } as unknown as StepUI<never>,
]);

const BPM = stepType("bpmkey", "BPM & Key", { defaultsJson: "{}" });
const SPIN = stepType("spin", "Spinner", { defaultsJson: SPIN_DEFAULTS });
const PLAIN = stepType("plain", "Plain", { defaultsJson: SPIN_DEFAULTS });
const CAT = [BPM, SPIN, PLAIN];

const withVars = (id: string, vars: Array<{ name: string; label: string; type?: WireType }>) => {
  const sc = stepCheck(id);
  sc.info.vars = vars.map((v) => ({ name: v.name, label: v.label, type: v.type }));
  return sc;
};

const steps3 = (): PipelineStep[] => [step(A, "bpmkey", { from: "input" }), step(B, "spin", { from: A }), step(C, "plain", { from: B })];
const chk = () => check([withVars(A, [{ name: "bpm", label: "BPM", type: WireType.ValueNumber }, { name: "key", label: "Key" }]), stepCheck(B), stepCheck(C)]);
const build = (s: PipelineStep[], layout = "", params: Parameters<typeof buildGraph>[3] = {}) => buildGraph(s, chk(), parseLayout(layout), { catalog: CAT, ...params });
const node = (g: ReturnType<typeof build>, id: string) => g.nodes.find((n) => n.id === id)!;

describe("stepParams", () => {
  it("derives parameters from the defaults, with the type's overrides", () => {
    const ps = stepParams(step(B, "spin", { optionsJson: '{"speed":2,"mode":"b"}' }), SPIN);
    expect(ps.map((p) => p.pointer)).toEqual(["/speed", "/mode", "/title", "/loud", "/tint", "/extra", "/deep/level"]);
    expect(ps.find((p) => p.pointer === "/mode")).toMatchObject({ type: "choice", primary: true, value: "b" });
    expect(ps.find((p) => p.pointer === "/speed")).toMatchObject({ label: "Speed", value: "2" });
    expect(ps.find((p) => p.pointer === "/tint")?.type).toBe("color");
    expect(ps.find((p) => p.pointer === "/loud")?.type).toBe("toggle");
  });

  it("falls back to the first three as primary without overrides, and caps primaries at four", () => {
    const ps = stepParams(step(C, "plain"), PLAIN);
    expect(ps.filter((p) => p.primary).map((p) => p.pointer)).toEqual(["/speed", "/title", "/loud"]);
  });

  it("has no parameters for manual steps and Check, and keeps wired options it doesn't know", () => {
    expect(stepParams(step(B, "spin", { manual: true }), SPIN)).toEqual([]);
    expect(stepParams(step(B, "pipelines.check"), undefined)).toEqual([]);
    const odd = stepParams(step(B, "spin", { optionsJson: '{"ghost":5}', binds: [{ option: "/ghost", var: "bpm" }] }), SPIN);
    const ghost = odd.find((p) => p.pointer === "/ghost");
    expect(ghost).toMatchObject({ label: "Ghost", type: "number", extra: true, value: "5", primary: true });
  });
});

describe("node ports and heights", () => {
  it("shows the files port, the primary parameters and a + N more row; the node is the taller column", () => {
    const g = build(steps3());
    const b = node(g, B);
    expect(b.params.map((p) => p.pointer)).toEqual(["/speed", "/mode"]);
    expect(b.more).toEqual({ side: "left", count: 5, expanded: false });
    // left: files + 2 primary params + more = 4 rows; right: 1 file port, no values
    expect(b.h).toBe(HEAD_H + SUMMARY_H + 4 * PORT_H + 6);
    expect(b.w).toBe(NODE_W);
    expect(inPortPos(b)).toEqual({ x: b.x, y: b.y + BODY_TOP + PORT_H / 2 });
    expect(paramPortPos(b, "/mode")).toEqual({ x: b.x, y: b.y + BODY_TOP + 2 * PORT_H + PORT_H / 2 });
    expect(moreRowIndex(b)).toBe(3);
  });

  it("opens to every parameter, 240 wide, when the node is in `expanded`", () => {
    const layout = serializeLayout({ v: 1, nodes: {}, view: { x: 0, y: 0, zoom: 1 }, expanded: [B] }, [INPUT_NODE, A, B, C]);
    const b = node(build(steps3(), layout), B);
    expect(b.params).toHaveLength(7);
    expect(b.more).toEqual({ side: "left", count: 5, expanded: true });
    expect(b.w).toBe(NODE_W_WIDE);
    expect(b.h).toBe(HEAD_H + SUMMARY_H + 9 * PORT_H + 6);
  });

  it("puts value outputs under the file ports, typed from Describe", () => {
    const g = build(steps3());
    const a = node(g, A);
    expect(a.values).toEqual([
      { id: "bpm", label: "BPM", type: "number" },
      { id: "key", label: "Key", type: "text" },
    ]);
    expect(valueOutPos(a, "key")).toEqual({ x: a.x + a.w, y: a.y + BODY_TOP + 2 * PORT_H + PORT_H / 2 });
    // right column: 1 + 2 rows; left: just the files row
    expect(a.h).toBe(HEAD_H + SUMMARY_H + 3 * PORT_H + 6);
  });

  it("the Input node lists run parameters, with the built-ins behind + N more", () => {
    const params = [{ name: "voice", label: "Voice", type: WireType.ValueChoice, default: "a", choices: ["a", "b"] }];
    const i = node(build(steps3(), "", { params }), INPUT_NODE);
    expect(i.values.map((v) => v.id)).toEqual(["voice"]);
    expect(i.values[0]?.type).toBe("choice");
    expect(i.more).toMatchObject({ side: "right", count: 8, expanded: false });
    const open = serializeLayout({ v: 1, nodes: {}, view: { x: 0, y: 0, zoom: 1 }, expanded: [INPUT_NODE] }, [INPUT_NODE, A, B, C]);
    const o = node(build(steps3(), open, { params }), INPUT_NODE);
    expect(o.values.map((v) => v.id)).toEqual(["item", "name", "ext", "role", "n", "date", "time", "pipeline", "voice"]);
    expect(o.values.find((v) => v.id === "n")?.type).toBe("number");
    expect(o.more?.expanded).toBe(true);
  });
});

describe("value wires in the graph", () => {
  const wired = (): PipelineStep[] => [
    step(A, "bpmkey", { from: "input" }),
    step(B, "spin", { from: A, binds: [{ option: "/speed", var: "bpm" }, { option: "/extra", var: "key" }] }),
    step(C, "plain", { from: B, binds: [{ option: "/title", var: "name" }] }),
  ];

  it("draws a wire per resolved bind, coloured by the source's type, ⚠ when the type is loose", () => {
    const g = build(wired());
    const vw = g.wires.filter((w) => w.channel === "value");
    expect(vw.map((w) => w.id)).toEqual([`${A}|v:bpm|${B}|/speed`, `${A}|v:key|${B}|/extra`, `${INPUT_NODE}|v:name|${C}|/title`]);
    expect(vw[0]).toMatchObject({ from: A, port: "bpm", to: B, valueType: "number", param: "/speed", loose: false });
    // text into a number is allowed but loose
    expect(vw[1]).toMatchObject({ valueType: "text", loose: true });
    // file wires are unchanged
    expect(g.wires.filter((w) => w.channel === "files")).toHaveLength(3);
  });

  it("keeps wired parameters visible when the node is collapsed, and shows what they take", () => {
    const b = node(build(wired()), B);
    expect(b.params.map((p) => p.pointer)).toEqual(["/speed", "/mode", "/extra"]);
    expect(b.params.find((p) => p.pointer === "/speed")?.display).toBe("← BPM & Key · BPM");
    expect(b.params.find((p) => p.pointer === "/extra")?.display).toBe("← BPM & Key · Key");
    expect(b.more?.count).toBe(4);
    // the Input's built-in the wire starts from is shown even though the built-ins are collapsed
    expect(node(build(wired()), INPUT_NODE).values.map((v) => v.id)).toEqual(["name"]);
  });

  it("marks ports with a wire, to draw them filled", () => {
    const g = build(wired());
    const w = wiredPortsByNode(g);
    expect(w.get(A)).toEqual(new Set(["in", "out:*", "val:bpm", "val:key"]));
    expect(w.get(B)).toEqual(new Set(["in", "out:*", "param:/speed", "param:/extra"]));
  });

  it("a bind nothing makes shows its name and draws no wire", () => {
    const s = [step(A, "bpmkey"), step(B, "spin", { from: A, binds: [{ option: "/speed", var: "ghost" }] })];
    const g = build(s);
    expect(g.wires.filter((x) => x.channel === "value")).toEqual([]);
    const row = node(g, B).params.find((p) => p.pointer === "/speed");
    expect(row?.display).toBe("← {ghost}");
    expect(row?.wired?.resolved).toBe(false);
  });

  it("the Runs graph (compact) shows only the files port and the wired parameters", () => {
    const g = runGraph(wired(), { catalog: CAT });
    const b = node(g, B);
    expect(b.params.map((p) => p.pointer)).toEqual(["/speed", "/extra"]);
    expect(b.more).toBeNull();
    expect(node(g, C).params.map((p) => p.pointer)).toEqual(["/title"]);
    expect(node(g, INPUT_NODE).more).toBeNull();
    expect(node(g, A).more).toBeNull();
  });
});

describe("value wiring rules", () => {
  const s0 = () => steps3();
  const run = (from: string, name: string, to: string, pointer: string, steps = s0()) => valueConnectReason(steps, chk(), CAT, [], from, name, to, pointer);

  it("number into a number is fine", () => {
    expect(run(A, "bpm", B, "/speed")).toEqual({ ok: true, loose: false, reason: "" });
  });

  it("text into a number is allowed but loose", () => {
    const v = run(A, "key", B, "/speed");
    expect(v.ok).toBe(true);
    expect(v.loose).toBe(true);
    expect(v.reason).toMatch(/fails/);
  });

  it("anything goes into text", () => {
    expect(run(A, "bpm", B, "/title")).toMatchObject({ ok: true, loose: false });
  });

  it("a number can't go into a toggle or a colour", () => {
    expect(run(A, "bpm", B, "/loud")).toMatchObject({ ok: false, reason: "Number can't go into on / off" });
    expect(run(A, "bpm", B, "/tint").ok).toBe(false);
  });

  it("refuses a value from a step that runs after (or is) the target", () => {
    const after = [step(A, "spin"), step(B, "spin", { from: A, label: "Later one" })];
    const c2 = check([stepCheck(A), withVars(B, [{ name: "bpm", label: "BPM", type: WireType.ValueNumber }])]);
    expect(valueConnectReason(after, c2, CAT, [], B, "bpm", A, "/speed")).toEqual({ ok: false, loose: false, reason: "Later one runs after this step" });
    expect(valueConnectReason(after, c2, CAT, [], B, "bpm", B, "/speed").reason).toBe("A step can't use its own values");
  });

  it("takes the input's built-ins and run parameters from anywhere", () => {
    expect(run(INPUT_NODE, "name", B, "/title")).toMatchObject({ ok: true });
    const params = [{ name: "speed_in", label: "Speed", type: WireType.ValueNumber, default: "1", choices: [] }];
    expect(valueConnectReason(s0(), chk(), CAT, params, INPUT_NODE, "speed_in", B, "/speed")).toMatchObject({ ok: true });
    expect(valueConnectReason(s0(), chk(), CAT, [], INPUT_NODE, "speed_in", B, "/speed").reason).toBe("That value doesn't exist");
  });

  it("refuses an unknown parameter", () => {
    expect(run(A, "bpm", B, "/nope").reason).toBe("That setting doesn't exist");
  });

  it("connectValue binds, replaces the parameter's old wire, and unbind removes it", () => {
    const r1 = connectValue(s0(), chk(), CAT, [], A, "bpm", B, "/speed");
    expect(r1.ok && r1.steps.find((s) => s.id === B)?.binds).toEqual([{ option: "/speed", var: "bpm" }]);
    if (!r1.ok) return;
    const r2 = connectValue(r1.steps, chk(), CAT, [], A, "key", B, "/speed");
    expect(r2.ok && r2.steps.find((s) => s.id === B)?.binds).toEqual([{ option: "/speed", var: "key" }]);
    if (!r2.ok) return;
    expect(r2.loose).toBe(true);
    expect(unbindValue(r2.steps, B, "/speed").find((s) => s.id === B)?.binds).toEqual([]);
    const refused = connectValue(s0(), chk(), CAT, [], A, "bpm", B, "/loud");
    expect(refused.ok).toBe(false);
  });

  it("unbindVar removes every bind of a variable, bindCount counts them", () => {
    const s = [step(A, "bpmkey"), step(B, "spin", { binds: [{ option: "/speed", var: "v" }, { option: "/title", var: "w" }] }), step(C, "plain", { binds: [{ option: "/speed", var: "v" }] })];
    expect(bindCount(s, "v")).toBe(2);
    const out = unbindVar(s, "v");
    expect(bindCount(out, "v")).toBe(0);
    expect(out.find((x) => x.id === B)?.binds).toEqual([{ option: "/title", var: "w" }]);
  });
});

describe("ask when the run starts", () => {
  const p0 = () => pipeline("p1", [step(A, "bpmkey"), step(B, "spin", { from: A, optionsJson: '{"speed":1.5,"mode":"b","loud":true,"title":"Hi","tint":"#112233"}' })], { params: [] });
  const def = (pointer: string) => stepParams((p0().steps ?? [])[1]!, SPIN).find((p) => p.pointer === pointer)!;
  const ask = (pointer: string, p = p0()) => askAtStart(p, chk(), B, def(pointer));

  it("adds a parameter with the label, type, current value as the default and the choices, and wires it", () => {
    const r = ask("/mode");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe("mode");
    expect(r.pipeline.params).toEqual([{ name: "mode", label: "Mode", type: "choice", default: "b", choices: ["a", "b"] }]);
    expect(r.pipeline.steps?.find((s) => s.id === B)?.binds).toEqual([{ option: "/mode", var: "mode" }]);
  });

  it("keeps numbers, toggles and colours as strings", () => {
    const num = ask("/speed");
    expect(num.ok && num.pipeline.params?.[0]).toMatchObject({ type: "number", default: "1.5", label: "Speed" });
    const tog = ask("/loud");
    expect(tog.ok && tog.pipeline.params?.[0]).toMatchObject({ type: "toggle", default: "true" });
    const col = ask("/tint");
    expect(col.ok && col.pipeline.params?.[0]).toMatchObject({ type: "color", default: "#112233" });
  });

  it("makes a valid, unique name: not a built-in, an existing parameter or a step's variable", () => {
    const r1 = ask("/title"); // "title"
    expect(r1.ok && r1.name).toBe("title");
    if (!r1.ok) return;
    const again = askAtStart(r1.pipeline, chk(), B, { ...def("/title"), label: "Title" });
    expect(again.ok && again.name).toBe("title_2");
    const builtin = askAtStart(p0(), chk(), B, { ...def("/title"), label: "Name" });
    expect(builtin.ok && builtin.name).toBe("name_2");
    const stepVar = askAtStart(p0(), chk(), B, { ...def("/title"), label: "BPM" });
    expect(stepVar.ok && stepVar.name).toBe("bpm_2");
    const odd = askAtStart(p0(), chk(), B, { ...def("/title"), label: "  1st / 2nd value!! " });
    expect(odd.ok && odd.name).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
  });

  it("isn't offered for a file, a choice with nothing to pick, or past 20 parameters", () => {
    expect(askAtStart(p0(), chk(), B, { ...def("/title"), type: "file" })).toEqual({ ok: false, reason: "A file can't be asked for when the run starts" });
    expect(askAtStart(p0(), chk(), B, { ...def("/mode"), choices: [{ value: "a", label: "A" }] }).ok).toBe(false);
    const full = { ...p0(), params: Array.from({ length: 20 }, (_, i) => ({ name: `p${i}`, label: `P${i}`, type: WireType.ValueText, default: "", choices: [] })) };
    expect(ask("/title", full).ok).toBe(false);
  });
});

describe("layout `expanded`", () => {
  it("round-trips, keeps only live nodes and is left out when empty (older layouts serialise as before)", () => {
    const json = serializeLayout({ v: 1, nodes: { a: { x: 1, y: 2 } }, view: { x: 0, y: 0, zoom: 1 }, expanded: ["a", "gone"] }, ["a"]);
    expect(JSON.parse(json).expanded).toEqual(["a"]);
    expect(parseLayout(json).expanded).toEqual(["a"]);
    const plain = serializeLayout({ v: 1, nodes: {}, view: { x: 0, y: 0, zoom: 1 } }, []);
    expect("expanded" in JSON.parse(plain)).toBe(false);
  });

  it("reads older layouts (no expanded) and ignores junk", () => {
    expect(parseLayout('{"v":1,"nodes":{},"view":{"x":0,"y":0,"zoom":1}}').expanded).toEqual([]);
    expect(parseLayout('{"expanded":[1,"ok",null]}').expanded).toEqual(["ok"]);
    expect(parseLayout('{"expanded":"x"}').expanded).toEqual([]);
  });
});
