import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  save: vi.fn(),
  describe: vi.fn(),
  pickFolder: vi.fn(),
  duplicate: vi.fn(),
  del: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    PipelinesService: {
      Save: (...a: unknown[]) => h.save(...a),
      Describe: (...a: unknown[]) => h.describe(...a),
      Duplicate: (...a: unknown[]) => h.duplicate(...a),
      Delete: (...a: unknown[]) => h.del(...a),
      List: async () => [],
      Runs: async () => [],
      Catalog: async () => [],
      Templates: async () => [],
    },
    FilesService: { PickFolder: (...a: unknown[]) => h.pickFolder(...a) },
  };
});

import type { Pipeline, PipelineEntry } from "@/lib/api";
import { registerSteps } from "@/pipelines/steps";
import { usePipelines } from "@/state/pipelines";
import { PipelineEditor } from "./PipelineEditor";
import { stepsOf } from "./editorModel";
import { CATALOG, check, entry, pipeline, product, step, stepCheck } from "./testFixtures";

const A = "aaaaaaaa";
const B = "bbbbbbbb";
const C = "cccccccc";

function seed(p: Pipeline, e?: Partial<PipelineEntry>) {
  usePipelines.setState({
    entries: [{ ...entry(p), ...e }],
    catalog: CATALOG,
    templates: [],
    runs: {},
    loaded: true,
    selectedPipelineId: p.id,
  });
}

const base = () =>
  pipeline("p1", [step(A, "downloader", { keep: false }), step(B, "stems", { from: A }), step(C, "trimmer", { from: B, keep: true })]);

/** Advances fake timers inside act. */
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

function lastSaved(): Pipeline {
  const calls = h.save.mock.calls;
  return calls[calls.length - 1]![0] as Pipeline;
}

beforeEach(() => {
  vi.useFakeTimers();
  h.save.mockImplementation(async (p: Pipeline) => entry(p));
  h.describe.mockImplementation(async (p: Pipeline) => check(stepsOf(p).map((s) => stepCheck(s.id))));
  h.pickFolder.mockResolvedValue("");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  usePipelines.setState({ entries: [], selectedPipelineId: null, runs: {} });
});

describe("PipelineEditor", () => {
  it("shows an empty state without a selection", () => {
    usePipelines.setState({ entries: [], selectedPipelineId: null });
    render(<PipelineEditor />);
    expect(screen.getByText("Select or create a pipeline")).toBeTruthy();
  });

  it("lists the steps in order with their numbers", () => {
    seed(base());
    render(<PipelineEditor />);
    const cards = screen.getAllByRole("region").filter((r) => r.getAttribute("data-step-id"));
    expect(cards.map((c) => c.getAttribute("data-step-id"))).toEqual([A, B, C]);
    expect(screen.getByRole("region", { name: "Step 2: Stem Splitter" })).toBeTruthy();
  });

  it("debounces autosave by 600 ms and Describe by 250 ms", async () => {
    seed(base());
    render(<PipelineEditor />);
    const name = screen.getByLabelText("Pipeline name");
    fireEvent.change(name, { target: { value: "Renamed" } });
    await tick(200);
    expect(h.describe).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "Renamed again" } });
    await tick(249);
    expect(h.describe).not.toHaveBeenCalled();
    await tick(2);
    expect(h.describe).toHaveBeenCalledTimes(1);
    expect(h.save).not.toHaveBeenCalled();
    await tick(400);
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(lastSaved().name).toBe("Renamed again");
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(usePipelines.getState().entries[0]?.pipeline.name).toBe("Renamed again");
  });

  it("shows a save failure and keeps the local edit", async () => {
    seed(base());
    h.save.mockRejectedValueOnce({ message: "Name already used" });
    render(<PipelineEditor />);
    fireEvent.change(screen.getByLabelText("Pipeline name"), { target: { value: "Dup" } });
    await tick(700);
    expect(screen.getByText(/Couldn't save/)).toBeTruthy();
    expect((screen.getByLabelText("Pipeline name") as HTMLInputElement).value).toBe("Dup");
  });

  it("adds a step from the menu with defaults, Keep on for the new last step", async () => {
    seed(base());
    render(<PipelineEditor />);
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Subtitles/ }));
    await tick(700);
    const saved = lastSaved();
    expect(stepsOf(saved)).toHaveLength(4);
    const added = stepsOf(saved)[3]!;
    expect(added).toMatchObject({ type: "subtitles", keep: true, manual: false, autoContinue: false });
    expect(added.id).toMatch(/^[a-z0-9]{8}$/);
    // The previous last step was the user's (loaded) Keep: untouched by the user, so it goes off.
    expect(stepsOf(saved)[2]?.keep).toBe(false);
  });

  it("keeps the previous last step's Keep when the user set it", async () => {
    seed(base());
    render(<PipelineEditor />);
    fireEvent.click(within(screen.getByRole("region", { name: /Step 3/ })).getByRole("button", { expanded: false }));
    fireEvent.click(screen.getByRole("switch", { name: /Keep its files/ })); // off
    fireEvent.click(screen.getByRole("switch", { name: /Keep its files/ })); // on again
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Stem Splitter/ }));
    await tick(700);
    expect(stepsOf(lastSaved()).map((s) => s.keep)).toEqual([false, false, true, true]);
  });

  it("opens the editor straight away for a new Visualizer step", async () => {
    seed(base());
    render(<PipelineEditor />);
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Visualizer/ }));
    const card = screen.getByRole("region", { name: /Step 4/ });
    expect(within(card).getByLabelText("Files from")).toBeTruthy();
  });

  it("dims incompatible tools with a reason and lists compatible ones first", async () => {
    seed(
      base(),
      { check: check([stepCheck(A, {}, [product("", [".mp4"])]), stepCheck(B, {}, [product("bass", [".flac"])]), stepCheck(C, {}, [product("", [".mp4"])])]) },
    );
    render(<PipelineEditor />);
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    const menu = screen.getByRole("menu", { name: "Add step" });
    const names = within(menu)
      .getAllByRole("menuitem")
      .map((i) => i.querySelectorAll("span")[1]?.textContent);
    expect(within(menu).getByText("Pipeline steps")).toBeTruthy();
    expect(names.slice(0, 2)).toEqual(["Check", "Ask Local Chat"]);
    const eraser = within(menu).getByRole("menuitem", { name: /Object Eraser/ });
    expect(eraser.textContent).toMatch(/nothing earlier makes/);
    // Within the media group Video Trimmer (reads .mp4) comes before Downloader (reads links only).
    expect(names.indexOf("Video Trimmer")).toBeLessThan(names.indexOf("Downloader"));
  });

  it("removes a step and rewires the one that read it", async () => {
    seed(base());
    render(<PipelineEditor />);
    fireEvent.click(within(screen.getByRole("region", { name: /Step 2/ })).getByRole("button", { expanded: false }));
    fireEvent.click(screen.getByRole("button", { name: /Remove/ }));
    await tick(700);
    const saved = lastSaved();
    expect(stepsOf(saved).map((s) => s.id)).toEqual([A, C]);
    expect(stepsOf(saved)[1]?.from).toBe(A);
  });

  it("moves a step with Alt+ArrowDown and keeps the handle focused", async () => {
    seed(base());
    render(<PipelineEditor />);
    const handle = document.querySelector<HTMLElement>(`[data-step-handle="${A}"]`)!;
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowDown", altKey: true });
    await tick(700);
    expect(stepsOf(lastSaved()).map((s) => s.id)).toEqual([B, A, C]);
    // B can no longer read A (now later): it reads the input instead.
    expect(stepsOf(lastSaved())[0]?.from).toBe("input");
    expect(document.activeElement).toBe(document.querySelector(`[data-step-handle="${A}"]`));
  });

  it("changes where a step reads from", async () => {
    seed(base());
    render(<PipelineEditor />);
    fireEvent.click(within(screen.getByRole("region", { name: /Step 3/ })).getByRole("button", { expanded: false }));
    const select = screen.getByLabelText("Files from") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(["The files you run it on", "Step 1 · Downloader", "Step 2 · Stem Splitter"]);
    fireEvent.change(select, { target: { value: A } });
    await tick(700);
    expect(stepsOf(lastSaved())[2]?.from).toBe(A);
  });

  it("filters by the source's roles and by name", async () => {
    const c = check([stepCheck(A), stepCheck(B, {}, [product("bass", [".flac"], "Bass"), product("vocals", [".flac"], "Vocals")]), stepCheck(C)]);
    h.describe.mockResolvedValue(c);
    seed(base(), { check: c });
    render(<PipelineEditor />);
    fireEvent.click(within(screen.getByRole("region", { name: /Step 3/ })).getByRole("button", { expanded: false }));
    fireEvent.click(screen.getByRole("button", { name: "Bass" }));
    fireEvent.click(screen.getByRole("button", { name: "More filters…" }));
    fireEvent.change(screen.getByLabelText("Name contains"), { target: { value: "final" } });
    await tick(700);
    const f = stepsOf(lastSaved())[2]!.filter;
    expect(f.roles).toEqual(["bass"]);
    expect(f.name).toBe("final");
    expect(within(screen.getByRole("region", { name: /Step 3/ })).getByText(/from step 2 · Bass only/)).toBeTruthy();
  });

  it("sets AutoContinue by tool when a step is made manual", async () => {
    seed(pipeline("p1", [step(A, "subtitles", { autoContinue: true }), step(B, "trimmer", { autoContinue: false })]));
    render(<PipelineEditor />);
    fireEvent.click(within(screen.getByRole("region", { name: /Step 1/ })).getByRole("button", { expanded: false }));
    fireEvent.click(screen.getByRole("radio", { name: /I'll do it myself in Subtitles/ }));
    await tick(700);
    expect(stepsOf(lastSaved())[0]).toMatchObject({ manual: true, autoContinue: false });
    expect(screen.getByText(/opens with the file loaded and uses its own settings/)).toBeTruthy();

    fireEvent.click(within(screen.getByRole("region", { name: /Step 2/ })).getByRole("button", { expanded: false }));
    fireEvent.click(screen.getAllByRole("radio", { name: /I'll do it myself in Video Trimmer/ })[0]!);
    await tick(700);
    expect(stepsOf(lastSaved())[1]).toMatchObject({ manual: true, autoContinue: true });
  });

  it("shows problems on the step they belong to and pipeline-level ones above", () => {
    seed(base(), {
      check: check([stepCheck(A), stepCheck(B, { problems: ["Stem Splitter can't read what step 1 makes (.mp4)"] }), stepCheck(C)], {
        ready: false,
        problems: ["Pick a name"],
      }),
    });
    render(<PipelineEditor />);
    const step2 = screen.getByRole("region", { name: /Step 2/ });
    expect(within(step2).getByText(/can't read what step 1 makes/)).toBeTruthy();
    expect(within(screen.getByRole("region", { name: /Step 1/ })).queryByText(/can't read/)).toBeNull();
    expect(screen.getByText("Pick a name")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Run…/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders the fallback and the Go summary for a step type without an editor", () => {
    seed(pipeline("p1", [step(A, "stems")]), {
      check: check([stepCheck(A, { info: { ...stepCheck(A).info, summary: "Four stems · FLAC" } })]),
    });
    render(<PipelineEditor />);
    fireEvent.click(screen.getByRole("button", { expanded: false, name: /Stem Splitter/ }));
    expect(screen.getByText("This step can't be edited here")).toBeTruthy();
    expect(screen.getAllByText("Four stems · FLAC").length).toBeGreaterThan(0);
  });

  it("uses the registered step editor and writes its value into optionsJson", async () => {
    registerSteps([
      {
        type: "stems",
        parse: (j: string) => ({ ...(JSON.parse(j || "{}") as object), quality: "x" }),
        Editor: ({ value, onChange }: { value: { quality: string }; onChange: (v: { quality: string }) => void }) => (
          <button onClick={() => onChange({ ...value, quality: "four" })}>edit options</button>
        ),
      },
    ] as never);
    seed(pipeline("p1", [step(A, "stems")]));
    render(<PipelineEditor />);
    fireEvent.click(screen.getByRole("button", { expanded: false, name: /Stem Splitter/ }));
    fireEvent.click(screen.getByRole("button", { name: "edit options" }));
    await tick(700);
    expect(JSON.parse(stepsOf(lastSaved())[0]!.optionsJson)).toMatchObject({ quality: "four" });
  });

  it("picks a watch folder and shows the watch message", async () => {
    h.pickFolder.mockResolvedValue("C:\\Watch");
    h.save.mockImplementation(async (p: Pipeline) => entry(p, undefined, { watch: { active: false, message: "Fix the problems in step 2" } }));
    seed(base());
    render(<PipelineEditor />);
    fireEvent.click(screen.getByRole("switch", { name: "Watch a folder" }));
    await tick(0);
    expect(h.pickFolder).toHaveBeenCalledWith("Watch folder");
    await tick(700);
    expect(lastSaved().watch).toEqual({ enabled: true, folder: "C:\\Watch" });
    expect(screen.getByText("Fix the problems in step 2")).toBeTruthy();
  });

  it("links the run history to the Runs tab filtered to the pipeline", () => {
    seed(base(), { lastRun: { id: "r1", status: "done" as never, createdAt: Date.now() - 600_000 } });
    render(<PipelineEditor />);
    expect(screen.getByText(/1 run · last: done 10m ago/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Runs/ }));
    expect(usePipelines.getState().tab).toBe("runs");
    expect(usePipelines.getState().runFilter).toBe("p1");
  });

  it("opens the Run sheet after flushing a pending save", async () => {
    seed(base());
    render(<PipelineEditor />);
    fireEvent.change(screen.getByLabelText("Pipeline name"), { target: { value: "Go" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Run…/ }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(usePipelines.getState().runSheet?.pipelineId).toBe("p1");
  });

  it("flushes a pending save when another pipeline is selected", async () => {
    const p1 = base();
    const p2 = pipeline("p2", [step(A, "downloader")]);
    usePipelines.setState({ entries: [entry(p1), entry(p2)], catalog: CATALOG, selectedPipelineId: "p1", loaded: true });
    render(<PipelineEditor />);
    fireEvent.change(screen.getByLabelText("Pipeline name"), { target: { value: "Quick edit" } });
    act(() => usePipelines.getState().selectPipeline("p2"));
    await tick(0);
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(lastSaved().name).toBe("Quick edit");
    expect((screen.getByLabelText("Pipeline name") as HTMLInputElement).value).toBe("Pipeline p2");
  });

  it("deletes after a confirm that mentions active runs", async () => {
    seed(base());
    usePipelines.setState({
      runs: { r1: { id: "r1", pipelineId: "p1", status: "running", createdAt: 1, items: [], steps: [], inputs: [] } as never },
    });
    h.del.mockResolvedValue(undefined);
    render(<PipelineEditor />);
    fireEvent.click(screen.getByRole("button", { name: "Pipeline actions" }));
    await tick(0);
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    expect(screen.getByText(/1 run is in progress and will keep going/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(h.del).toHaveBeenCalledWith("p1");
    expect(usePipelines.getState().entries).toHaveLength(0);
    expect(h.save).not.toHaveBeenCalled();
  });
});
