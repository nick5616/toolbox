import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    PipelinesService: { Save: async (p: unknown) => p, Describe: async () => undefined, List: async () => [], Runs: async () => [], Catalog: async () => [], Templates: async () => [] },
    FilesService: { PickFolder: async () => "" },
  };
});

import { ValueType as WireType, type Pipeline, type PipelineStep } from "@/lib/api";
import { registerSteps, type StepUI } from "@/pipelines/steps/registry";
import { useDraft } from "./draftStore";
import { stepsOf } from "./editorModel";
import { INPUT_NODE } from "./graphModel";
import { StepPanel, stepPanelSummary } from "./panels";
import { check, entry, pipeline, step, stepCheck, stepType } from "./testFixtures";

const SPIN_DEFAULTS = '{"speed":1,"title":"Hi","loud":false,"mode":"a"}';
registerSteps([
  {
    type: "spin",
    parse: (j: string) => JSON.parse(j) as unknown,
    Editor: () => <div>spin editor</div>,
    params: { "/mode": { type: "choice", choices: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }], primary: true }, "/speed": { primary: true, label: "Speed" } },
  } as unknown as StepUI<never>,
]);

const A = "aaaaaaaa";
const B = "bbbbbbbb";
const CAT = [stepType("bpmkey", "BPM & Key", { defaultsJson: "{}" }), stepType("spin", "Spinner", { defaultsJson: SPIN_DEFAULTS })];

const chk = (p: Pipeline) =>
  check(
    stepsOf(p).map((s) => {
      const sc = stepCheck(s.id);
      if (s.id === A) sc.info.vars = [{ name: "bpm", label: "BPM", type: WireType.ValueNumber }, { name: "key", label: "Key" }];
      return sc;
    }),
  );

function open(steps: PipelineStep[], o: Partial<Pipeline> = {}, select: string = B) {
  const p = pipeline("p1", steps, o);
  useDraft.getState().open(entry(p, chk(p)));
  useDraft.getState().setLive({ catalog: CAT });
  useDraft.getState().select(select);
  return render(<StepPanel />);
}

const stepB = () => stepsOf(useDraft.getState().draft!).find((s) => s.id === B)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  cleanup();
  useDraft.getState().close();
  vi.useRealTimers();
});

describe("StepPanel · Wired section", () => {
  const plain = () => [step(A, "bpmkey"), step(B, "spin", { from: A })];
  const wired = () => [step(A, "bpmkey"), step(B, "spin", { from: A, optionsJson: '{"speed":120}', binds: [{ option: "/speed", var: "bpm" }] })];

  it("shows an empty Wired section with an Add a wire… button, above the step's own editor", () => {
    open(plain());
    const section = screen.getByRole("region", { name: "Wired settings" });
    expect(within(section).getByText("Nothing is wired. A wired setting takes its value from a variable at run time.")).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Add a wire…" })).toBeTruthy();
    expect(screen.getByText("spin editor")).toBeTruthy();
    expect(section.compareDocumentPosition(screen.getByText("spin editor")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("lists a wire with its source and what the step uses when the wire is empty", () => {
    open(wired());
    const row = document.querySelector<HTMLElement>('[data-param="/speed"]')!;
    expect(within(row).getByText("Speed")).toBeTruthy();
    expect(within(row).getByText("← BPM & Key · BPM")).toBeTruthy();
    expect(within(row).getByText("If the wire is empty, uses 120")).toBeTruthy();
  });

  it("changes the value a parameter takes with the select, offering only values that fit", () => {
    open(wired());
    const select = screen.getByRole("combobox", { name: "Value for Speed" }) as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toContain("BPM & Key · BPM");
    expect(labels).toContain("BPM & Key · Key"); // text into a number: allowed
    expect(labels).toContain("Input · Item number");
    fireEvent.change(select, { target: { value: "n" } });
    expect(stepB().binds).toEqual([{ option: "/speed", var: "n" }]);
  });

  it("unwires with the ×", () => {
    open(wired());
    fireEvent.click(screen.getByRole("button", { name: "Unwire Speed" }));
    expect(stepB().binds).toEqual([]);
    expect(screen.getByText("Nothing is wired. A wired setting takes its value from a variable at run time.")).toBeTruthy();
  });

  it("adds a wire through the parameter → variable picker", () => {
    open(plain());
    fireEvent.click(screen.getByRole("button", { name: "Add a wire…" }));
    const group = screen.getByRole("group", { name: "Add a wire" });
    fireEvent.change(within(group).getByRole("combobox", { name: "Setting to wire" }), { target: { value: "/speed" } });
    fireEvent.change(within(group).getByRole("combobox", { name: "Value to wire in" }), { target: { value: "bpm" } });
    fireEvent.click(within(group).getByRole("button", { name: "Wire" }));
    expect(stepB().binds).toEqual([{ option: "/speed", var: "bpm" }]);
    expect(screen.queryByRole("group", { name: "Add a wire" })).toBeNull();
  });

  it("the picker leaves out values a setting can't take", () => {
    open(plain());
    fireEvent.click(screen.getByRole("button", { name: "Add a wire…" }));
    const group = screen.getByRole("group", { name: "Add a wire" });
    // Mode is a choice: text and choice values fit, a number only loosely, a toggle doesn't (none exist here)
    fireEvent.change(within(group).getByRole("combobox", { name: "Setting to wire" }), { target: { value: "/mode" } });
    const choices = Array.from((within(group).getByRole("combobox", { name: "Value to wire in" }) as HTMLSelectElement).options).map((o) => o.value);
    expect(choices).toContain("key");
    expect(choices).toContain("bpm");
  });

  it("says when a wired value can no longer come from before this step", () => {
    open([step(A, "bpmkey"), step(B, "spin", { from: A, binds: [{ option: "/speed", var: "ghost" }] })]);
    expect(screen.getByText("Nothing before this step makes {ghost}")).toBeTruthy();
  });
});

describe("StepPanel · Input node: Run parameters", () => {
  const params = [
    { name: "speed", label: "Speed", type: WireType.ValueNumber, default: "1", choices: [] },
    { name: "voice", label: "Voice", type: WireType.ValueChoice, default: "am_adam", choices: ["am_adam", "af_bella"] },
  ];
  const steps = () => [step(A, "bpmkey"), step(B, "spin", { from: A, binds: [{ option: "/speed", var: "speed" }, { option: "/title", var: "speed" }] })];
  const draft = () => useDraft.getState().draft!;

  it("lists each parameter with its type, name, label and default", () => {
    open(steps(), { params }, INPUT_NODE);
    const section = screen.getByRole("region", { name: "Run parameters" });
    expect(within(section).getByText("{speed}")).toBeTruthy();
    expect((within(section).getByRole("spinbutton", { name: "Default of Speed" }) as HTMLInputElement).value).toBe("1");
    expect((within(section).getByRole("combobox", { name: "Default of Voice" }) as HTMLSelectElement).value).toBe("am_adam");
    expect((within(section).getByRole("textbox", { name: "Label of speed" }) as HTMLInputElement).value).toBe("Speed");
  });

  it("explains how to make one when there are none", () => {
    open(steps(), {}, INPUT_NODE);
    expect(screen.getByText(/Ask when the run starts/)).toBeTruthy();
  });

  it("edits a default while it's valid for its type, and keeps the last good one otherwise", () => {
    open(steps(), { params }, INPUT_NODE);
    const field = screen.getByRole("spinbutton", { name: "Default of Speed" });
    fireEvent.change(field, { target: { value: "2.5" } });
    expect(draft().params?.[0]?.default).toBe("2.5");
    fireEvent.change(field, { target: { value: "" } });
    expect(draft().params?.[0]?.default).toBe("2.5");
    fireEvent.change(screen.getByRole("combobox", { name: "Default of Voice" }), { target: { value: "af_bella" } });
    expect(draft().params?.[1]?.default).toBe("af_bella");
  });

  it("renames the label (the name stays) and never saves an empty label", () => {
    open(steps(), { params }, INPUT_NODE);
    const field = screen.getByRole("textbox", { name: "Label of speed" });
    fireEvent.change(field, { target: { value: "Playback speed" } });
    expect(draft().params?.[0]).toMatchObject({ name: "speed", label: "Playback speed" });
    fireEvent.change(field, { target: { value: "  " } });
    expect(draft().params?.[0]?.label).toBe("Playback speed");
    fireEvent.blur(field);
    expect((field as HTMLInputElement).value).toBe("Playback speed");
  });

  it("removes a parameter after a confirmation that says how many wires go with it", () => {
    open(steps(), { params }, INPUT_NODE);
    fireEvent.click(screen.getByRole("button", { name: "Remove Speed" }));
    expect(screen.getByText(/also unwires 2 settings/)).toBeTruthy();
    act(() => void fireEvent.click(screen.getByRole("button", { name: "Remove" })));
    expect(draft().params?.map((p) => p.name)).toEqual(["voice"]);
    expect(stepB().binds).toEqual([]);
  });

  it("a parameter nothing uses is removed after a plain confirmation", () => {
    open(steps(), { params }, INPUT_NODE);
    fireEvent.click(screen.getByRole("button", { name: "Remove Voice" }));
    expect(screen.getByText("Nothing is wired to it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(draft().params?.map((p) => p.name)).toEqual(["speed"]);
    expect(stepB().binds).toHaveLength(2);
  });

  it("summarises the Input node for the panel's click-in bar", () => {
    const p = pipeline("p", [step(A, "bpmkey")], { params });
    expect(stepPanelSummary(INPUT_NODE, p, CAT)).toBe("Input · 2 run parameters");
    expect(stepPanelSummary(INPUT_NODE, pipeline("p", [step(A, "bpmkey")]), CAT)).toBe("Input");
  });
});
