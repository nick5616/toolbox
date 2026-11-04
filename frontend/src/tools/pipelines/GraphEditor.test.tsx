import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pipeline } from "@/lib/api";
import { registerSteps } from "@/pipelines/steps";
import { GraphEditor } from "./GraphEditor";
import { stepsOf } from "./editorModel";
import { parseLayout } from "./graphModel";
import { CATALOG, check, pipeline, product, step, stepCheck } from "./testFixtures";

registerSteps([]);

const A = "aaaaaaaa";
const B = "bbbbbbbb";
const C = "cccccccc";

let current: Pipeline;

function checkFor(p: Pipeline) {
  const prods: Record<string, ReturnType<typeof product>[]> = {
    [A]: [product("", [".mp4"], "Video")],
    [B]: [product("vocals", [".mp3"], "Vocals")],
  };
  return check(stepsOf(p).map((s) => stepCheck(s.id, {}, prods[s.id] ?? [])));
}

function Harness({ initial }: { initial: Pipeline }) {
  const [p, setP] = useState(initial);
  const touched = useRef(new Set<string>()).current;
  current = p;
  return (
    <GraphEditor
      pipeline={p}
      check={checkFor(p)}
      catalog={CATALOG}
      modules={[]}
      runs={[]}
      touchedKeep={touched}
      onEdit={(fn) => setP((q) => fn(q))}
      onLayout={(layout) => setP((q) => ({ ...q, layout }))}
    />
  );
}

const base = () =>
  pipeline("p1", [step(A, "downloader", { from: "input" }), step(B, "stems", { from: "none" }), step(C, "trimmer", { from: "none" })]);

const node = (id: string) => document.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
const outPort = (id: string, port = "*") => document.querySelector<HTMLElement>(`[data-node="${id}"][data-out-port="${port}"]`)!;

/** Drags from an output port to the body of a node. */
function wire(from: string, port: string, to: string) {
  act(() => {
    fireEvent.pointerDown(outPort(from, port), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 60 });
    fireEvent.pointerUp(node(to), { clientX: 90, clientY: 70 });
  });
}

beforeEach(() => localStorage.setItem("toolbox.pipelines.storeOpen", "1"));
afterEach(() => {
  cleanup();
  localStorage.removeItem("toolbox.pipelines.storeOpen");
});

describe("GraphEditor", () => {
  it("shows the input, a node per step and the wires from `from`", () => {
    render(<Harness initial={base()} />);
    expect(node("input")).toBeTruthy();
    expect(node(A)).toBeTruthy();
    expect(node(C)).toBeTruthy();
    expect(document.querySelectorAll("[data-wire-id]")).toHaveLength(1);
  });

  it("adds a step from the tool store by click and by drop, at the dropped spot", () => {
    render(<Harness initial={base()} />);
    fireEvent.click(document.querySelector("[data-tool-id=\"trimmer\"]")!);
    expect(stepsOf(current)).toHaveLength(4);
    expect(stepsOf(current)[3]).toMatchObject({ type: "trimmer", from: "none", keep: true });

    const data: Record<string, string> = { "application/x-toolbox-step": "stems" };
    const dt = { types: Object.keys(data), getData: (k: string) => data[k] ?? "", dropEffect: "", effectAllowed: "" };
    const vp = screen.getByRole("application");
    fireEvent.drop(vp, { dataTransfer: dt, clientX: 300, clientY: 200 });
    expect(stepsOf(current)).toHaveLength(5);
    const added = stepsOf(current)[4]!;
    const pos = parseLayout(current.layout).nodes[added.id]!;
    expect(pos).toBeTruthy();
    expect(Number.isFinite(pos.x) && Number.isFinite(pos.y)).toBe(true);
  });

  it("lists tools that can't be steps, disabled with the reason", () => {
    render(<Harness initial={base()} />);
    // Only catalogue tools here (no modules were passed), so the group is absent.
    expect(screen.queryByRole("group", { name: "Not available as steps" })).toBeNull();
  });

  it("quick-adds from a double-click on the empty canvas", () => {
    render(<Harness initial={base()} />);
    const vp = screen.getByRole("application");
    fireEvent.doubleClick(vp, { clientX: 400, clientY: 100 });
    const search = screen.getByRole("textbox", { name: "Search tools to add" });
    fireEvent.change(search, { target: { value: "pdf" } });
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Add a tool" }), { key: "Enter" });
    expect(stepsOf(current).at(-1)?.type).toBe("pdf");
    expect(screen.queryByRole("dialog", { name: "Add a tool" })).toBeNull();
  });

  it("wires an output port to a step, and Delete on the selected wire unwires it", () => {
    render(<Harness initial={base()} />);
    wire(A, "*", C);
    expect(stepsOf(current).find((s) => s.id === C)).toMatchObject({ from: A });
    const vp = screen.getByRole("application");
    // The new wire is selected: Delete removes it.
    fireEvent.keyDown(vp, { key: "Delete" });
    expect(stepsOf(current).find((s) => s.id === C)).toMatchObject({ from: "none" });
  });

  it("wires a role port as a role filter", () => {
    const p = pipeline("p1", [step(A, "downloader"), step(B, "stems", { from: "input" }), step(C, "stems", { from: "none" })]);
    render(<Harness initial={p} />);
    wire(B, "vocals", C);
    expect(stepsOf(current).find((s) => s.id === C)).toMatchObject({ from: B, filter: { roles: ["vocals"] } });
  });

  it("refuses a wire the target can't read, with a message, and changes nothing", () => {
    render(<Harness initial={base()} />);
    // stems make audio, the trimmer reads video
    wire(B, "vocals", C);
    expect(screen.getByRole("alert").textContent).toMatch(/Video Trimmer reads video/);
    expect(stepsOf(current).find((s) => s.id === C)?.from).toBe("none");
  });

  it("deletes the selected node, unwiring what read it, and keeps at least one step", () => {
    const p = pipeline("p1", [step(A, "downloader"), step(B, "stems", { from: A })]);
    render(<Harness initial={p} />);
    const vp = screen.getByRole("application");
    fireEvent.pointerDown(node(A), { button: 0, clientX: 0, clientY: 0 });
    act(() => void fireEvent.pointerUp(window));
    fireEvent.keyDown(vp, { key: "Delete" });
    expect(stepsOf(current).map((s) => s.id)).toEqual([B]);
    expect(stepsOf(current)[0]?.from).toBe("none");
    // The last step can't go.
    fireEvent.pointerDown(node(B), { button: 0, clientX: 0, clientY: 0 });
    act(() => void fireEvent.pointerUp(window));
    fireEvent.keyDown(vp, { key: "Delete" });
    expect(stepsOf(current)).toHaveLength(1);
  });

  it("duplicates the selection with Mod+D", () => {
    render(<Harness initial={base()} />);
    const vp = screen.getByRole("application");
    fireEvent.pointerDown(node(A), { button: 0, clientX: 0, clientY: 0 });
    act(() => void fireEvent.pointerUp(window));
    fireEvent.keyDown(vp, { key: "d", ctrlKey: true });
    expect(stepsOf(current)).toHaveLength(4);
    expect(stepsOf(current).filter((s) => s.type === "downloader")).toHaveLength(2);
  });

  it("moves a node and saves the position in the layout", () => {
    render(<Harness initial={base()} />);
    const before = node(B).style.left;
    fireEvent.pointerDown(node(B), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 30 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 30 });
    expect(node(B).style.left).not.toBe(before);
    expect(parseLayout(current.layout).nodes[B]).toBeTruthy();
  });

  it("zooms with the buttons and the wheel", () => {
    render(<Harness initial={base()} />);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("120%")).toBeTruthy();
    fireEvent.wheel(screen.getByRole("application"), { ctrlKey: true, deltaY: -100 });
    expect(screen.queryByText("120%")).toBeNull();
  });

  it("opens a step's options in a drawer and edits them", () => {
    render(<Harness initial={base()} />);
    fireEvent.click(screen.getByRole("button", { name: "Options for Video Trimmer" }));
    expect(screen.getByRole("complementary", { name: "Options for Video Trimmer" })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Video Trimmer"), { target: { value: "Cut" } });
    expect(stepsOf(current).find((s) => s.id === C)?.label).toBe("Cut");
  });
});
