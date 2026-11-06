import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ start: vi.fn(), pick: vi.fn() }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    PipelinesService: { Start: (...a: unknown[]) => h.start(...a), List: async () => [], Runs: async () => [], Catalog: async () => [], Templates: async () => [] },
    FilesService: { PickWith: (...a: unknown[]) => h.pick(...a) },
  };
});

import { ValueType, type PipelineParam } from "@/lib/api";
import { usePipelines } from "@/state/pipelines";
import { RunSheet } from "./RunSheet";
import { acc, check, entry, pipeline, step, stepCheck } from "./testFixtures";
import { run } from "./RunGridFixtures";

function setup(opts: { accepts?: ReturnType<typeof acc>; secrets?: { stepId: string; key: string; label: string }[]; inputs?: string[]; ready?: boolean; params?: PipelineParam[] } = {}) {
  const p = pipeline("p1", [step("s1", "stems")], { name: "Stems", params: opts.params ?? [] });
  const c = check([stepCheck("s1")], { accepts: opts.accepts ?? acc([".mp3", ".wav"], { urls: true }), secrets: opts.secrets ?? [], ready: opts.ready ?? true });
  usePipelines.setState({ entries: [entry(p, c)], runs: {}, runSheet: { pipelineId: "p1", inputs: opts.inputs ?? [] }, loaded: true });
  return render(<RunSheet pipelineId="p1" />);
}

beforeEach(() => {
  h.start.mockImplementation(async () => run("r1"));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RunSheet", () => {
  it("strikes out inputs the pipeline can't take and starts with the accepted ones", async () => {
    setup({ inputs: ["/a/song.mp3", "/a/notes.txt"] });
    const list = screen.getByRole("list", { name: "Inputs" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]?.getAttribute("data-accepted")).toBe("true");
    expect(items[1]?.getAttribute("data-accepted")).toBe("false");
    expect(within(items[1]!).getByText("not for this pipeline")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(h.start).toHaveBeenCalled());
    expect(h.start).toHaveBeenCalledWith({ pipelineId: "p1", inputs: ["/a/song.mp3"], secrets: {}, params: {} });
    await waitFor(() => expect(usePipelines.getState().runSheet).toBeNull());
    expect(usePipelines.getState().tab).toBe("runs");
    expect(usePipelines.getState().selectedRunId).toBe("r1");
  });

  it("disables Start with nothing acceptable", () => {
    setup({ inputs: ["/a/notes.txt"] });
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("takes links when the pipeline accepts them", async () => {
    setup();
    fireEvent.change(screen.getByLabelText("Links"), { target: { value: "https://example.com/v\nnot a link\nhttp://x.test/a" } });
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Start with 2 files" }));
    await waitFor(() => expect(h.start).toHaveBeenCalled());
    expect(h.start.mock.calls[0]?.[0].inputs).toEqual(["https://example.com/v", "http://x.test/a"]);
  });

  it("hides the links box and strikes links when the pipeline takes none", () => {
    setup({ accepts: acc([".mp3"]), inputs: ["https://example.com/v", "/a/b.mp3"] });
    expect(screen.queryByLabelText("Links")).toBeNull();
    expect(screen.getAllByRole("listitem")[0]?.getAttribute("data-accepted")).toBe("false");
  });

  it("asks for each password and sends them under <step>.<key>", async () => {
    setup({ inputs: ["/a/song.mp3"], secrets: [{ stepId: "s1", key: "password", label: "Step 3 · PDF password" }] });
    const field = screen.getByLabelText("Step 3 · PDF password") as HTMLInputElement;
    expect(field.type).toBe("password");
    const start = screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "hunter2" } });
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    await waitFor(() => expect(h.start).toHaveBeenCalled());
    expect(h.start).toHaveBeenCalledWith({ pipelineId: "p1", inputs: ["/a/song.mp3"], secrets: { "s1.password": "hunter2" }, params: {} });
  });

  it("shows a Start error inline and keeps the sheet open", async () => {
    h.start.mockRejectedValue({ message: "Needs FFmpeg", hint: "Install it in Settings" });
    setup({ inputs: ["/a/song.mp3"] });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(screen.getByText("Needs FFmpeg")).toBeTruthy());
    expect(usePipelines.getState().runSheet).not.toBeNull();
  });

  it("adds picked files, de-duplicated", async () => {
    h.pick.mockResolvedValue(["/a/song.mp3", "/a/two.wav"]);
    setup({ inputs: ["/a/song.mp3"] });
    fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
    await waitFor(() => expect(usePipelines.getState().runSheet?.inputs).toEqual(["/a/song.mp3", "/a/two.wav"]));
    expect(h.pick).toHaveBeenCalledWith("Run Stems", [".mp3", ".wav"], true);
  });

  it("has the pipeline-run drop zone and Esc closes", () => {
    setup();
    expect(document.getElementById("pipeline-run:p1")?.hasAttribute("data-file-drop-target")).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(usePipelines.getState().runSheet).toBeNull();
  });

  it("blocks Start for a pipeline that isn't ready", () => {
    setup({ inputs: ["/a/song.mp3"], ready: false });
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
  });

  describe("run parameters", () => {
    const params: PipelineParam[] = [
      { name: "title", label: "Title", type: ValueType.ValueText, default: "Hello", choices: [] },
      { name: "speed", label: "Speed", type: ValueType.ValueNumber, default: "1.1", choices: [] },
      { name: "loud", label: "Loud", type: ValueType.ValueToggle, default: "false", choices: [] },
      { name: "voice", label: "Voice", type: ValueType.ValueChoice, default: "am_adam", choices: ["am_adam", "af_bella"] },
      { name: "tint", label: "Tint", type: ValueType.ValueColor, default: "#112233", choices: [] },
    ];

    it("shows a field per parameter, fitting its type and pre-filled with the default", () => {
      setup({ inputs: ["/a/song.mp3"], params });
      const group = screen.getByRole("group", { name: "Run parameters" });
      expect((within(group).getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe("Hello");
      const speed = within(group).getByRole("spinbutton", { name: "Speed" }) as HTMLInputElement;
      expect(speed.type).toBe("number");
      expect(speed.value).toBe("1.1");
      expect(within(group).getByRole("switch", { name: "Loud" }).getAttribute("aria-checked")).toBe("false");
      expect((within(group).getByRole("combobox", { name: "Voice" }) as HTMLSelectElement).value).toBe("am_adam");
      expect((within(group).getByRole("textbox", { name: "Tint" }) as HTMLInputElement).value).toBe("#112233");
    });

    it("sends every parameter with the edited values and the defaults of the rest", async () => {
      setup({ inputs: ["/a/song.mp3"], params });
      const group = screen.getByRole("group", { name: "Run parameters" });
      fireEvent.change(within(group).getByRole("spinbutton", { name: "Speed" }), { target: { value: "1.5" } });
      fireEvent.click(within(group).getByRole("switch", { name: "Loud" }));
      fireEvent.change(within(group).getByRole("combobox", { name: "Voice" }), { target: { value: "af_bella" } });
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
      await waitFor(() => expect(h.start).toHaveBeenCalled());
      expect(h.start).toHaveBeenCalledWith({
        pipelineId: "p1",
        inputs: ["/a/song.mp3"],
        secrets: {},
        params: { title: "Hello", speed: "1.5", loud: "true", voice: "af_bella", tint: "#112233" },
      });
    });

    it("disables Start while a colour isn't a colour", () => {
      setup({ inputs: ["/a/song.mp3"], params });
      const group = screen.getByRole("group", { name: "Run parameters" });
      fireEvent.change(within(group).getByRole("textbox", { name: "Tint" }), { target: { value: "red" } });
      expect(screen.getByRole("button", { name: "Start" }).getAttribute("aria-disabled")).toBe("true");
      fireEvent.change(within(group).getByRole("textbox", { name: "Tint" }), { target: { value: "#abcdef" } });
      expect(screen.getByRole("button", { name: "Start" }).getAttribute("aria-disabled")).toBeNull();
    });
  });
});
