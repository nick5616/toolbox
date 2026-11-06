import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ValueType as WireType, type Pipeline, type PipelineStep } from "@/lib/api";
import { registerSteps, type StepUI } from "@/pipelines/steps/registry";
import { GraphEditor } from "./GraphEditor";
import { stepsOf } from "./editorModel";
import { parseLayout } from "./graphModel";
import { LEGEND_KEY } from "./Legend";
import { check, pipeline, step, stepCheck, stepType } from "./testFixtures";

const SPIN_DEFAULTS = '{"speed":1,"title":"Hi","loud":false,"tint":"#112233","mode":"a","extra":3}';
registerSteps([
  {
    type: "spin",
    parse: (j: string) => JSON.parse(j) as unknown,
    Editor: () => null,
    params: { "/mode": { type: "choice", choices: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }], primary: true }, "/speed": { primary: true, label: "Speed" } },
  } as unknown as StepUI<never>,
]);

const A = "aaaaaaaa";
const B = "bbbbbbbb";
const C = "cccccccc";
const CAT = [stepType("bpmkey", "BPM & Key", { defaultsJson: "{}" }), stepType("spin", "Spinner", { defaultsJson: SPIN_DEFAULTS }), stepType("plain", "Plain", { defaultsJson: SPIN_DEFAULTS })];

let current: Pipeline;
let opened: Array<[string, string | undefined]> = [];

function checkFor(p: Pipeline) {
  return check(
    stepsOf(p).map((s) => {
      const sc = stepCheck(s.id);
      if (s.id === A) sc.info.vars = [{ name: "bpm", label: "BPM", type: WireType.ValueNumber }, { name: "key", label: "Key" }];
      if (s.id === C) sc.info.vars = [{ name: "late", label: "Late", type: WireType.ValueNumber }];
      return sc;
    }),
  );
}

function Harness({ initial }: { initial: Pipeline }) {
  const [p, setP] = useState(initial);
  const touched = useRef(new Set<string>()).current;
  current = p;
  return (
    <GraphEditor
      pipeline={p}
      check={checkFor(p)}
      catalog={CAT}
      modules={[]}
      runs={[]}
      touchedKeep={touched}
      onEdit={(fn) => setP((q) => fn(q))}
      onLayout={(layout) => setP((q) => ({ ...q, layout }))}
      onOpenStep={(id, pointer) => opened.push([id, pointer])}
    />
  );
}

const steps = (): PipelineStep[] => [step(A, "bpmkey", { from: "input" }), step(B, "spin", { from: A }), step(C, "plain", { from: B })];
const base = (o: Partial<Pipeline> = {}) => pipeline("p1", steps(), o);

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const valueOut = (node: string, name: string) => q(`[data-value-out="${name}"][data-node="${node}"]`);
const paramPort = (node: string, pointer: string) => q(`[data-param-port="${pointer}"][data-node="${node}"]`);
const paramRow = (node: string, pointer: string) => q(`[data-param-row="${pointer}"][data-node="${node}"]`);
const valueRow = (node: string, name: string) => q(`[data-value-row="${name}"][data-node="${node}"]`);
const bindsOf = (id: string) => stepsOf(current).find((s) => s.id === id)?.binds;

/** Drags from one element to another (the drop target is whatever is under the pointer when it's released). */
function drag(from: HTMLElement, to: HTMLElement) {
  act(() => {
    fireEvent.pointerDown(from, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 60 });
    fireEvent.pointerUp(to, { clientX: 90, clientY: 70 });
  });
}

beforeEach(() => {
  localStorage.setItem("toolbox.pipelines.storeOpen", "0");
  opened = [];
});
afterEach(() => {
  cleanup();
  localStorage.removeItem("toolbox.pipelines.storeOpen");
  localStorage.removeItem(LEGEND_KEY);
});

describe("GraphEditor parameters", () => {
  it("shows the files port first, then the primary parameters with their values, and value outputs on the right", () => {
    render(<Harness initial={base()} />);
    const rows = Array.from(document.querySelectorAll(`[data-node-id="${B}"] [data-param-row]`)).map((r) => r.getAttribute("data-param-row"));
    expect(rows).toEqual(["/speed", "/mode"]);
    expect(within(q(`[data-node-id="${B}"]`)).getByText("Alpha")).toBeTruthy();
    expect(q(`[data-node-id="${B}"] [data-in-port]`)).toBeTruthy();
    expect(valueOut(A, "bpm")).toBeTruthy();
    expect(valueOut(A, "key")).toBeTruthy();
    // a filled port has a wire, a hollow one doesn't: the files input of B is wired, its speed isn't
    expect(q(`[data-node-id="${B}"] [data-in-port]`).className).toMatch(/dotOn/);
    expect(paramPort(B, "/speed").className).not.toMatch(/dotOn/);
  });

  it("opens and closes a node's + N more, and remembers it in the layout", () => {
    render(<Harness initial={base()} />);
    fireEvent.click(within(q(`[data-node-id="${B}"]`)).getByRole("button", { name: "+ 4 more" }));
    expect(parseLayout(current.layout).expanded).toEqual([B]);
    expect(document.querySelectorAll(`[data-node-id="${B}"] [data-param-row]`)).toHaveLength(6);
    fireEvent.click(within(q(`[data-node-id="${B}"]`)).getByRole("button", { name: "Fewer" }));
    expect(parseLayout(current.layout).expanded ?? []).toEqual([]);
    expect(document.querySelectorAll(`[data-node-id="${B}"] [data-param-row]`)).toHaveLength(2);
  });

  it("wires a value output to a parameter by dragging, and the wire is thin and typed", () => {
    render(<Harness initial={base()} />);
    drag(valueOut(A, "bpm"), paramRow(B, "/speed"));
    expect(bindsOf(B)).toEqual([{ option: "/speed", var: "bpm" }]);
    expect(within(paramRow(B, "/speed")).getByText("← BPM & Key · BPM")).toBeTruthy();
    const w = q(`[data-wire-channel="value"]`);
    expect(w.getAttribute("style")).toMatch(/--type-number/);
    expect(w.getAttribute("style")).toMatch(/stroke-width: 1\.6/);
    expect(w.getAttribute("style")).not.toMatch(/dasharray/);
    expect(paramPort(B, "/speed").className).toMatch(/dotOn/);
  });

  it("wires the other way too: from a parameter port to a value output", () => {
    render(<Harness initial={base()} />);
    drag(paramPort(B, "/speed"), valueRow(A, "bpm"));
    expect(bindsOf(B)).toEqual([{ option: "/speed", var: "bpm" }]);
  });

  it("draws a text-into-number wire dashed", () => {
    render(<Harness initial={base()} />);
    drag(valueOut(A, "key"), paramRow(B, "/speed"));
    expect(bindsOf(B)).toEqual([{ option: "/speed", var: "key" }]);
    expect(q(`[data-wire-channel="value"]`).getAttribute("style")).toMatch(/stroke-dasharray/);
  });

  it("replaces the wire when another value is dropped on the same parameter", () => {
    render(<Harness initial={base()} />);
    drag(valueOut(A, "bpm"), paramRow(B, "/speed"));
    drag(valueOut(A, "key"), paramRow(B, "/speed"));
    expect(bindsOf(B)).toEqual([{ option: "/speed", var: "key" }]);
    expect(document.querySelectorAll('[data-wire-channel="value"]')).toHaveLength(1);
  });

  it("refuses a wire that doesn't fit, saying why, and changes nothing", () => {
    render(<Harness initial={base()} />);
    // a number can't go into an on/off setting (open the node so the toggle shows)
    fireEvent.click(within(q(`[data-node-id="${B}"]`)).getByRole("button", { name: "+ 4 more" }));
    drag(valueOut(A, "bpm"), paramRow(B, "/loud"));
    expect(screen.getByRole("alert").textContent).toBe("Number can't go into on / off");
    expect(bindsOf(B)).toEqual([]);
  });

  it("refuses a value from a step that runs after this one", () => {
    render(<Harness initial={base()} />);
    drag(valueOut(C, "late"), paramRow(B, "/speed"));
    expect(screen.getByRole("alert").textContent).toBe("Plain runs after this step");
    expect(bindsOf(B)).toEqual([]);
  });

  it("selecting a wire and pressing Delete unbinds; so does clicking a wired port then Delete", () => {
    render(<Harness initial={base({ steps: [step(A, "bpmkey"), step(B, "spin", { from: A, binds: [{ option: "/speed", var: "bpm" }] }), step(C, "plain", { from: B })] })} />);
    const vp = screen.getByRole("application");
    // click the wired parameter's port (no move): selects its wire
    act(() => {
      fireEvent.pointerDown(paramPort(B, "/speed"), { button: 0, clientX: 5, clientY: 5 });
      fireEvent.pointerUp(paramPort(B, "/speed"), { clientX: 5, clientY: 5 });
    });
    expect(screen.getByRole("button", { name: "Remove this wire" })).toBeTruthy();
    fireEvent.keyDown(vp, { key: "Delete" });
    expect(bindsOf(B)).toEqual([]);
    // wire again, then select via the wire's hit path
    drag(valueOut(A, "bpm"), paramRow(B, "/speed"));
    fireEvent.keyDown(vp, { key: "Delete" });
    expect(bindsOf(B)).toEqual([]);
  });

  it("wires with the keyboard: Enter on a value output, then Enter on a parameter port", () => {
    render(<Harness initial={base()} />);
    fireEvent.keyDown(valueOut(A, "bpm"), { key: "Enter" });
    fireEvent.keyDown(paramPort(B, "/speed"), { key: "Enter" });
    expect(bindsOf(B)).toEqual([{ option: "/speed", var: "bpm" }]);
  });

  it("highlights the legal targets while a value is dragged and dims the others", () => {
    render(<Harness initial={base()} />);
    act(() => {
      fireEvent.pointerDown(valueOut(A, "bpm"), { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(window, { clientX: 80, clientY: 60 });
    });
    expect(paramRow(B, "/speed").className).toMatch(/portOk/);
    expect(valueRow(A, "key").className).toMatch(/portDim/);
    act(() => void fireEvent.pointerUp(window));
  });

  it("clicking a parameter row asks to open the step options at that setting", () => {
    render(<Harness initial={base()} />);
    fireEvent.click(paramRow(B, "/mode"));
    expect(opened).toEqual([[B, "/mode"]]);
  });

  it("the port menu's Ask when the run starts adds a run parameter and wires it", () => {
    render(<Harness initial={base({ steps: [step(A, "bpmkey"), step(B, "spin", { from: A, optionsJson: '{"speed":2.5,"mode":"b"}' }), step(C, "plain", { from: B })] })} />);
    fireEvent.contextMenu(paramRow(B, "/speed"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Ask when the run starts" }));
    expect(current.params).toEqual([{ name: "speed", label: "Speed", type: "number", default: "2.5", choices: [] }]);
    expect(bindsOf(B)).toEqual([{ option: "/speed", var: "speed" }]);
    // the Input node now shows it as an output, and the wire starts there
    expect(valueOut("input", "speed")).toBeTruthy();
    expect(within(paramRow(B, "/speed")).getByText("← Speed")).toBeTruthy();

    // a choice carries its choices
    fireEvent.contextMenu(paramRow(B, "/mode"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Ask when the run starts" }));
    expect(current.params?.[1]).toEqual({ name: "mode", label: "Mode", type: "choice", default: "b", choices: ["a", "b"] });
  });

  it("the port menu can unwire, and says why Ask isn't available", () => {
    const p = base({ steps: [step(A, "bpmkey"), step(B, "spin", { from: A, binds: [{ option: "/speed", var: "bpm" }] }), step(C, "plain", { from: B })], params: Array.from({ length: 20 }, (_, i) => ({ name: `p${i}`, label: `P${i}`, type: WireType.ValueText, default: "", choices: [] })) });
    render(<Harness initial={p} />);
    fireEvent.contextMenu(paramRow(B, "/speed"));
    const ask = screen.getByRole("menuitem", { name: "Ask when the run starts" });
    expect(ask.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("menu").textContent).toMatch(/20 run parameters/);
    fireEvent.click(screen.getByRole("menuitem", { name: "Unwire" }));
    expect(bindsOf(B)).toEqual([]);
  });

  it("file wires are orange for every media kind and carry the kind only as a label", () => {
    render(<Harness initial={base()} />);
    const files = Array.from(document.querySelectorAll('[data-wire-channel="files"]'));
    expect(files.length).toBeGreaterThan(0);
    for (const w of files) {
      expect(w.getAttribute("style")).toMatch(/--type-files/);
      expect(w.getAttribute("class")).not.toMatch(/k_/);
    }
  });

  it("the legend collapses to a Colours chip and remembers it", () => {
    localStorage.setItem(LEGEND_KEY, "1");
    const { unmount } = render(<Harness initial={base()} />);
    const group = screen.getByRole("group", { name: "Colours" });
    expect(within(group).getByText("Number")).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: /Colours/ }));
    expect(screen.queryByRole("group", { name: "Colours" })).toBeNull();
    expect(localStorage.getItem(LEGEND_KEY)).toBe("0");
    unmount();
    render(<Harness initial={base()} />);
    expect(screen.queryByRole("group", { name: "Colours" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Colours" }));
    expect(screen.getByRole("group", { name: "Colours" })).toBeTruthy();
    expect(localStorage.getItem(LEGEND_KEY)).toBe("1");
  });

  it("the Input node opens its options (the Run parameters panel)", () => {
    render(<Harness initial={base()} />);
    fireEvent.click(screen.getByRole("button", { name: "Options for Input" }));
    expect(opened).toEqual([["input", undefined]]);
  });
});
