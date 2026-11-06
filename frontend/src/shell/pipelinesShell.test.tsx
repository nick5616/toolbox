import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ start: vi.fn(), cont: vi.fn(), skip: vi.fn(), match: vi.fn() }));
vi.mock("@/lib/events", () => ({ on: () => () => undefined }));
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    PipelinesService: {
      Start: (...a: unknown[]) => h.start(...a),
      Continue: (...a: unknown[]) => h.cont(...a),
      SkipStep: (...a: unknown[]) => h.skip(...a),
      List: async () => [],
      Runs: async () => [],
      Catalog: async () => [],
      Templates: async () => [],
    },
    ModulesService: { Match: (...a: unknown[]) => h.match(...a) },
    ClipboardService: { OpenPopup: vi.fn(), Pause: vi.fn(), Resume: vi.fn() },
    VaultService: { State: async () => ({ unlocked: false }), Lock: vi.fn() },
  };
});

import { useToastStore } from "@/components/toast";
import { CellStatus, Category, ErrorCode, JobStatus, ModuleStatus, RunStatus, WaitKind, type Descriptor, type FilesDropped } from "@/lib/api";
import { enabledCommands, useCommandRegistry } from "@/lib/commands";
import { normalizeJob, useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { usePipelines } from "@/state/pipelines";
import { useUI } from "@/state/ui";
import { acc, check, entry, pipeline, step, stepCheck } from "@/tools/pipelines/testFixtures";
import { cell, file, item, run } from "@/tools/pipelines/RunGridFixtures";
import { sendToItems } from "@/views/LibraryView";
import { DropOverlay } from "./DropOverlay";
import { JobRow } from "./JobRow";
import { PipelineBanner } from "./PipelineBanner";
import { Sidebar } from "./Sidebar";
import { routeFilesDropped } from "./dropRouting";
import { useBuiltinCommands } from "./useBuiltinCommands";
import { usePipelineNotices } from "./usePipelineNotices";

function mod(id: string, name: string): Descriptor {
  return {
    id, name, tagline: "", description: "", icon: "box", category: Category.$zero, status: ModuleStatus.StatusReady,
    accepts: { extensions: [".mp4"], urls: false, any: false }, requires: null, recommends: null, outputSubdir: "", order: 1, hidden: false, jobLess: false, maxInputs: 0, base: "", parts: null,
  };
}

const drop = (targetId: string, paths: string[]): FilesDropped => ({ paths, targetId, result: { matches: null, unmatched: null } }) as FilesDropped;

function entries(o: { ready?: boolean; secrets?: boolean } = {}) {
  const p = pipeline("p1", [step("s1", "stems")], { name: "Stems" });
  const c = check([stepCheck("s1")], {
    accepts: acc([".mp3"]),
    ready: o.ready ?? true,
    secrets: o.secrets ? [{ stepId: "s1", key: "password", label: "Step 1 · PDF password" }] : [],
  });
  return [entry(p, c)];
}

const toastTitles = () => useToastStore.getState().toasts.map((t) => t.title);

function waitingRun(id = "r1", stepType = "trimmer", note = "Pick the part to keep") {
  return run(id, {
    name: "Clip for social",
    status: RunStatus.RunWaiting,
    needsYou: 1,
    steps: [step("s1", "stems"), step("s2", stepType, { manual: true, note })],
    items: [item(0, "a.mp4", [cell("s1", CellStatus.CellDone), cell("s2", CellStatus.CellWaiting, { wait: WaitKind.WaitManual, inputs: [file("/lib/a.mp4")] })])],
  });
}

beforeEach(() => {
  h.start.mockResolvedValue(run("new1"));
  h.cont.mockResolvedValue(undefined);
  h.skip.mockResolvedValue(undefined);
  useToastStore.setState({ toasts: [] });
  useModules.getState().setAll([mod("trimmer", "Video Trimmer"), mod("stems", "Stem Splitter")]);
  useUI.setState({ view: "library", drop: null, handoff: null });
  useJobs.setState({ byId: {}, logs: {}, logsLoaded: {} });
  usePipelines.setState({ entries: [], runs: {}, runSheet: null, selectedRunId: null, tab: "pipelines", loaded: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("drop routing", () => {
  it("starts at once when the pipeline is ready, needs no secrets and takes a path", async () => {
    usePipelines.setState({ entries: entries() });
    routeFilesDropped(drop("pipeline-drop:p1", ["/a.mp3", "/b.mp3", "/c.txt"]));
    await waitFor(() => expect(h.start).toHaveBeenCalledWith({ pipelineId: "p1", inputs: ["/a.mp3", "/b.mp3"], secrets: {}, params: {} }));
    await waitFor(() => expect(toastTitles()).toContain("Started Stems with 2 files"));
    expect(usePipelines.getState().runSheet).toBeNull();
    expect(usePipelines.getState().runs.new1).toBeDefined();
    const t = useToastStore.getState().toasts.find((x) => x.title.startsWith("Started"));
    act(() => t?.action?.onClick());
    expect(useUI.getState().view).toBe("pipelines");
    expect(usePipelines.getState().selectedRunId).toBe("new1");
  });

  it.each([
    ["needs a secret", { secrets: true }, ["/a.mp3"]],
    ["is not ready", { ready: false }, ["/a.mp3"]],
    ["accepts none of the files", {}, ["/a.txt"]],
  ])("opens the Run sheet when the pipeline %s", (_n, o, paths) => {
    usePipelines.setState({ entries: entries(o) });
    routeFilesDropped(drop("pipeline-drop:p1", paths));
    expect(h.start).not.toHaveBeenCalled();
    expect(usePipelines.getState().runSheet).toEqual({ pipelineId: "p1", inputs: paths });
    expect(useUI.getState().view).toBe("pipelines");
  });

  it("opens the Run sheet if the instant start fails", async () => {
    h.start.mockRejectedValue({ message: "Needs FFmpeg" });
    usePipelines.setState({ entries: entries() });
    routeFilesDropped(drop("pipeline-drop:p1", ["/a.mp3"]));
    await waitFor(() => expect(usePipelines.getState().runSheet?.pipelineId).toBe("p1"));
    expect(toastTitles()).toContain("Needs FFmpeg");
  });

  it("adds paths to the open sheet on pipeline-run drops", () => {
    usePipelines.setState({ entries: entries(), runSheet: { pipelineId: "p1", inputs: ["/a.mp3"] } });
    routeFilesDropped(drop("pipeline-run:p1", ["/a.mp3", "/b.mp3"]));
    expect(usePipelines.getState().runSheet?.inputs).toEqual(["/a.mp3", "/b.mp3"]);
  });
});

describe("DropOverlay", () => {
  it("lists pipelines that take at least one dropped path", () => {
    usePipelines.setState({ entries: entries() });
    useUI.setState({ drop: drop("", ["/a.mp3", "/b.txt"]) as never });
    render(<DropOverlay />);
    const list = screen.getByRole("list", { name: "Pipelines" });
    expect(within(list).getByText("Stems")).toBeTruthy();
    expect(within(list).getByText("a.mp3")).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: "Run Stems" }));
    expect(usePipelines.getState().runSheet).toEqual({ pipelineId: "p1", inputs: ["/a.mp3"] });
    expect(useUI.getState().drop).toBeNull();
    expect(useUI.getState().view).toBe("pipelines");
  });

  it("has no Pipelines section when none takes the files", () => {
    usePipelines.setState({ entries: entries() });
    useUI.setState({ drop: drop("", ["/b.txt"]) as never });
    render(<DropOverlay />);
    expect(screen.queryByRole("list", { name: "Pipelines" })).toBeNull();
    expect(screen.getByText("No tool accepts these files yet.")).toBeTruthy();
  });
});

describe("Library Send to", () => {
  it("adds 'Pipeline: <name>' after the tools", async () => {
    h.match.mockResolvedValue({ matches: [{ module: mod("stems", "Stem Splitter"), paths: ["/a.mp3"] }], unmatched: [] });
    usePipelines.setState({ entries: entries() });
    const items = await sendToItems("/a.mp3");
    expect(items.map((i) => i.label)).toEqual(["Open in Stem Splitter", "Open in Stem Splitter (new window)", "Pipeline: Stems"]);
    items[2]?.onSelect();
    expect(usePipelines.getState().runSheet).toEqual({ pipelineId: "p1", inputs: ["/a.mp3"] });
    expect(useUI.getState().view).toBe("pipelines");
  });

  it("leaves out pipelines that don't take the file", async () => {
    h.match.mockResolvedValue({ matches: [], unmatched: [] });
    usePipelines.setState({ entries: entries() });
    expect(await sendToItems("/a.txt")).toEqual([]);
  });
});

describe("palette", () => {
  it("offers the pipeline commands", () => {
    useCommandRegistry.setState({ commands: {} });
    usePipelines.setState({ entries: entries() });
    renderHook(() => useBuiltinCommands());
    const cmds = enabledCommands();
    const titles = cmds.map((c) => c.title);
    expect(titles).toEqual(expect.arrayContaining(["Open Pipelines", "New pipeline…", "Run pipeline: Stems", "Show pipeline runs"]));
    cmds.find((c) => c.title === "Run pipeline: Stems")?.run();
    expect(usePipelines.getState().runSheet?.pipelineId).toBe("p1");
    cmds.find((c) => c.title === "Show pipeline runs")?.run();
    expect(usePipelines.getState().tab).toBe("runs");
    expect(useUI.getState().view).toBe("pipelines");
  });
});

describe("PipelineBanner", () => {
  it("shows for the waiting module only", () => {
    usePipelines.getState().setRuns([waitingRun()]);
    const { container, rerender } = render(<PipelineBanner view="trimmer" />);
    expect(screen.getByText("Clip for social is waiting: Pick the part to keep")).toBeTruthy();
    rerender(<PipelineBanner view="stems" />);
    expect(container.textContent).toBe("");
    rerender(<PipelineBanner view="library" />);
    expect(container.textContent).toBe("");
  });

  it("Skip step and Show run call through; Continue needs a finished adopted job", () => {
    usePipelines.getState().setRuns([waitingRun()]);
    render(<PipelineBanner view="trimmer" />);
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Skip step" }));
    expect(h.skip).toHaveBeenCalledWith("r1", 0, "s2");
    fireEvent.click(screen.getByRole("button", { name: "Show run" }));
    expect(usePipelines.getState().selectedRunId).toBe("r1");
    expect(useUI.getState().view).toBe("pipelines");
  });

  it("enables Continue once an adopted job is done", () => {
    const r = waitingRun();
    r.items![0]!.cells![1]!.jobIds = ["j1"];
    usePipelines.getState().setRuns([r]);
    useJobs.setState({
      byId: {
        j1: normalizeJob({
          id: "j1", moduleId: "trimmer", title: "t", status: JobStatus.JobDone, progress: 1, message: "", inputs: null, optionsJson: "{}", errorCode: ErrorCode.$zero,
          error: "", errorHint: "", attempt: 1, cancelRequested: false, createdAt: 1, startedAt: 1, finishedAt: 2,
          outputs: [{ id: "o", jobId: "j1", moduleId: "trimmer", path: "/x.mp4", name: "x.mp4", kind: "video", sizeBytes: 1, createdAt: 1, tags: null, missing: false }] as never,
          resultJson: "", pipelineRunId: "r1", pipelineStepId: "s2",
        }),
      },
    });
    render(<PipelineBanner view="trimmer" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(h.cont).toHaveBeenCalledWith({ runId: "r1", item: 0, stepId: "s2", keep: null, passThrough: false });
  });

  it("summarises several waiting steps", () => {
    const r = waitingRun();
    r.items!.push(item(1, "b.mp4", [cell("s1", CellStatus.CellDone), cell("s2", CellStatus.CellWaiting, { wait: WaitKind.WaitManual })]));
    usePipelines.getState().setRuns([r]);
    render(<PipelineBanner view="trimmer" />);
    expect(screen.getByText("2 pipeline steps are waiting")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(usePipelines.getState().tab).toBe("runs");
  });
});

describe("JobRow pipeline chip", () => {
  const mk = (o: Record<string, unknown>) =>
    normalizeJob({
      id: "j1", moduleId: "trimmer", title: "Clip", status: JobStatus.JobRunning, progress: 0.5, message: "", inputs: null, optionsJson: "{}", errorCode: ErrorCode.$zero,
      error: "", errorHint: "", attempt: 1, cancelRequested: false, createdAt: 1, startedAt: 1, finishedAt: 0, outputs: null, resultJson: "", pipelineRunId: "", pipelineStepId: "", ...o,
    } as never);

  it("shows run name and step n/N and navigates to the run", () => {
    usePipelines.getState().setRuns([waitingRun()]);
    render(<JobRow job={mk({ pipelineRunId: "r1", pipelineStepId: "s2" })} />);
    const chip = screen.getByRole("button", { name: /Clip for social/ });
    expect(chip.textContent).toContain("2/2");
    fireEvent.click(chip);
    expect(useUI.getState().view).toBe("pipelines");
    expect(usePipelines.getState().tab).toBe("runs");
    expect(usePipelines.getState().selectedRunId).toBe("r1");
  });

  it("has no chip for ordinary jobs", () => {
    render(<JobRow job={mk({})} />);
    expect(screen.queryByTitle("Show this pipeline run")).toBeNull();
  });
});

describe("Sidebar pipelines item", () => {
  it("shows the needs-you count and the running dot", () => {
    usePipelines.getState().setRuns([waitingRun()]);
    render(<Sidebar />);
    const btn = screen.getByRole("button", { name: /Pipelines/ });
    expect(within(btn).getByLabelText("1 waiting for you").textContent).toBe("1");
    expect(within(btn).getByTestId("running-indicator")).toBeTruthy();
  });

  it("is quiet with no active runs", () => {
    usePipelines.getState().setRuns([run("d", { status: RunStatus.RunDone })]);
    render(<Sidebar />);
    const btn = screen.getByRole("button", { name: /Pipelines/ });
    expect(within(btn).queryByTestId("running-indicator")).toBeNull();
    expect(btn.textContent).toBe("Pipelines");
  });
});

describe("needs-you toasts", () => {
  it("toasts when a cell starts waiting live, not for runs already waiting", () => {
    usePipelines.getState().setRuns([waitingRun("old")]);
    renderHook(() => usePipelineNotices());
    expect(toastTitles()).toEqual([]);

    act(() => usePipelines.getState().upsertRun(waitingRun("fresh", "trimmer", "")));
    expect(toastTitles()).toEqual(["Clip for social needs you"]);
    const t = useToastStore.getState().toasts[0]!;
    expect(t.action?.label).toBe("Open Video Trimmer");
    expect(t.duration).toBe(document.hasFocus() ? 8000 : 0);
    act(() => t.action?.onClick());
    expect(useUI.getState().view).toBe("trimmer");
    expect(useUI.getState().handoff).toEqual({ moduleId: "trimmer", inputs: ["/lib/a.mp4"] });

    // The same cell updating again doesn't toast again.
    act(() => usePipelines.getState().upsertRun(waitingRun("fresh", "trimmer", "")));
    expect(toastTitles()).toHaveLength(1);
  });

  it("offers 'Check files' for check cells", () => {
    renderHook(() => usePipelineNotices());
    const r = waitingRun("c1");
    r.items![0]!.cells![1]!.wait = WaitKind.WaitCheck;
    act(() => usePipelines.getState().upsertRun(r));
    expect(useToastStore.getState().toasts[0]?.action?.label).toBe("Check files");
  });

  it("stays silent for runs loaded at boot", () => {
    usePipelines.setState({ loaded: false });
    renderHook(() => usePipelineNotices());
    act(() => usePipelines.getState().setRuns([waitingRun("boot")]));
    act(() => usePipelines.setState({ loaded: true }));
    expect(toastTitles()).toEqual([]);
  });

  it("uses a 0 duration when the window isn't focused", () => {
    const spy = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    renderHook(() => usePipelineNotices());
    act(() => usePipelines.getState().upsertRun(waitingRun("bg")));
    expect(useToastStore.getState().toasts[0]?.duration).toBe(0);
    spy.mockRestore();
  });
});
