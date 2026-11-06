import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cancel: vi.fn(),
  retry: vi.fn(),
  clean: vi.fn(),
  remove: vi.fn(),
  cont: vi.fn(),
  skip: vi.fn(),
  stop: vi.fn(),
  thumb: vi.fn(),
  openFolder: vi.fn(),
  open: vi.fn(),
  reveal: vi.fn(),
  revealPath: vi.fn(),
  match: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    PipelinesService: {
      Cancel: (...a: unknown[]) => h.cancel(...a),
      Retry: (...a: unknown[]) => h.retry(...a),
      CleanUp: (...a: unknown[]) => h.clean(...a),
      Remove: (...a: unknown[]) => h.remove(...a),
      Continue: (...a: unknown[]) => h.cont(...a),
      SkipStep: (...a: unknown[]) => h.skip(...a),
      StopItem: (...a: unknown[]) => h.stop(...a),
      List: async () => [],
      Runs: async () => [],
      Catalog: async () => [],
      Templates: async () => [],
    },
    FilesService: { ImageThumb: (...a: unknown[]) => h.thumb(...a) },
    LibraryService: {
      OpenLibraryFolder: (...a: unknown[]) => h.openFolder(...a),
      Open: (...a: unknown[]) => h.open(...a),
      Reveal: (...a: unknown[]) => h.reveal(...a),
      RevealPath: (...a: unknown[]) => h.revealPath(...a),
    },
    ModulesService: { Match: (...a: unknown[]) => h.match(...a) },
  };
});

import { useToastStore } from "@/components/toast";
import { CellStatus, ErrorCode, JobStatus, OutputKind, RunStatus, WaitKind } from "@/lib/api";
import { normalizeJob, useJobs } from "@/state/jobs";
import { usePipelines } from "@/state/pipelines";
import { useUI } from "@/state/ui";
import { useRunModeStore } from "./RunGraphMode";
import { RunsPanel } from "./RunsPanel";
import { CATALOG, entry, pipeline, step } from "./testFixtures";
import { cell, file, item, run } from "./RunGridFixtures";

function job(id: string, o: Record<string, unknown> = {}) {
  return normalizeJob({
    id, moduleId: "trimmer", title: `Job ${id}`, status: JobStatus.JobDone, progress: 1, message: "", inputs: null, optionsJson: "{}",
    errorCode: ErrorCode.$zero, error: "", errorHint: "", attempt: 1, cancelRequested: false, createdAt: 1, startedAt: 1, finishedAt: 2,
    outputs: null, resultJson: "", pipelineRunId: "", pipelineStepId: "", ...o,
  } as never);
}

function setRuns(...runs: ReturnType<typeof run>[]) {
  usePipelines.setState({ runs: {}, selectedRunId: null, runFilter: "", tab: "runs" });
  usePipelines.getState().setRuns(runs);
}

beforeEach(() => {
  // These tests are about the List view; the graph has its own tests (RunGraph.test.tsx).
  localStorage.setItem("toolbox.pipelines.runViewMode", "list");
  useRunModeStore.setState({ mode: null });
  h.retry.mockImplementation(async (id: string) => run(id));
  for (const m of [h.cancel, h.clean, h.remove, h.cont, h.skip, h.stop, h.openFolder, h.open, h.reveal, h.revealPath]) m.mockResolvedValue(undefined);
  h.clean.mockResolvedValue(2);
  h.thumb.mockResolvedValue("data:image/png;base64,AAA");
  h.match.mockResolvedValue({ matches: [], unmatched: [] });
  useJobs.setState({ byId: {}, logs: {}, logsLoaded: {} });
  usePipelines.setState({ entries: [entry(pipeline("p1", [step("s1", "stems")], { name: "Stems" }))], catalog: CATALOG });
  useUI.setState({ trayOpen: false, expandedLogJobId: null, handoff: null, view: "pipelines" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const gridCell = (name: RegExp) => screen.getByRole("button", { name });

describe("RunsPanel list", () => {
  it("lists active runs first, then newest, with progress and the needs-you badge", () => {
    setRuns(
      run("old", { name: "Old run", status: RunStatus.RunDone, createdAt: 1, items: [item(0, "a.mp3", [cell("s1", CellStatus.CellDone), cell("s2", CellStatus.CellDone)])] }),
      run("new", { name: "New run", status: RunStatus.RunPartial, createdAt: 3, items: [item(0, "a.mp3", [cell("s1", CellStatus.CellDone), cell("s2", CellStatus.CellDone)]), item(1, "b.mp3", [cell("s1", CellStatus.CellFailed), cell("s2", CellStatus.CellBlocked)])] }),
      run("live", { name: "Live run", status: RunStatus.RunWaiting, createdAt: 2, needsYou: 1, items: [item(0, "a.mp3", [cell("s1", CellStatus.CellDone), cell("s2", CellStatus.CellWaiting, { wait: WaitKind.WaitManual })])] }),
    );
    render(<RunsPanel />);
    const rows = within(screen.getByRole("list", { name: "Runs" })).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Live run"),
      expect.stringContaining("New run"),
      expect.stringContaining("Old run"),
    ]);
    expect(rows[0]?.textContent).toContain("Needs you");
    expect(rows[0]?.textContent).toContain("0 of 1 file");
    expect(rows[1]?.textContent).toContain("1 of 2 files");
    expect(rows[2]?.textContent).toContain("1 of 1 file");
  });

  it("selects the newest run when none is selected", async () => {
    setRuns(run("a", { createdAt: 1 }), run("b", { createdAt: 5 }));
    render(<RunsPanel />);
    await waitFor(() => expect(usePipelines.getState().selectedRunId).toBe("b"));
  });

  it("filters by pipeline", () => {
    setRuns(run("a", { name: "Alpha", pipelineId: "p1" }), run("b", { name: "Beta", pipelineId: "p2" }));
    render(<RunsPanel />);
    fireEvent.change(screen.getByLabelText("Filter runs by pipeline"), { target: { value: "p2" } });
    const list = screen.getByRole("list", { name: "Runs" });
    expect(within(list).queryByText("Alpha")).toBeNull();
    expect(within(list).getByText("Beta")).toBeTruthy();
  });

  it("shows an empty state without runs", () => {
    setRuns();
    render(<RunsPanel />);
    expect(screen.getByText("No runs yet")).toBeTruthy();
  });
});

describe("RunGrid", () => {
  it("shows one status per cell and gathers merged items under their sources", () => {
    const statuses = [CellStatus.CellDone, CellStatus.CellFailed, CellStatus.CellBlocked, CellStatus.CellSkipped, CellStatus.CellMerged, CellStatus.CellNone];
    const steps = statuses.map((_, i) => step(`s${i}`, "stems"));
    setRuns(
      run("r", {
        steps,
        items: [
          item(0, "a.mp3", statuses.map((s, i) => cell(`s${i}`, s))),
          item(1, "b.mp3", statuses.map((_, i) => cell(`s${i}`, CellStatus.CellDone))),
          item(2, "All 2 files", statuses.map((_, i) => cell(`s${i}`, CellStatus.CellNone)), { merged: [0, 1], input: "" }),
        ],
      }),
    );
    render(<RunsPanel />);
    const labels = ["Done", "Failed", "Blocked", "Skipped", "Gathered", "Not applicable"];
    labels.forEach((l, i) => expect(screen.getByRole("button", { name: `Stem Splitter, a.mp3: ${l}` }), `step ${i}`).toBeTruthy());
    const rows = within(screen.getByRole("table", { name: "Run progress" })).getAllByRole("row");
    expect(rows.map((r) => r.querySelector("th")?.textContent)).toEqual(["File", "a.mp3", "b.mp3", "All 2 files"]);
  });

  it("shows job progress on a running cell", () => {
    useJobs.setState({ byId: { j1: job("j1", { status: JobStatus.JobRunning, progress: 0.4 }) } });
    setRuns(run("r", { items: [item(0, "a.mp3", [cell("s1", CellStatus.CellRunning, { jobIds: ["j1"] }), cell("s2", CellStatus.CellPending)])] }));
    render(<RunsPanel />);
    expect(gridCell(/Stem Splitter, a.mp3: Running/).textContent).toContain("40%");
    expect(gridCell(/Video Trimmer, a.mp3: Pending/).getAttribute("data-status")).toBe("pending");
  });
});

describe("CellPopover", () => {
  it("shows the error and hint of a failed cell, its jobs and files", () => {
    useJobs.setState({ byId: { j9: job("j9", { status: JobStatus.JobFailed, title: "Split stems" }) } });
    setRuns(
      run("r", {
        items: [
          item(0, "a.mp3", [
            cell("s1", CellStatus.CellFailed, { error: "Model missing", errorHint: "Install the AI engine", jobIds: ["j9"], files: [file("/lib/a-vocals.wav", { outputId: "o1", roleLabel: "Vocals" })] }),
            cell("s2", CellStatus.CellBlocked),
          ], { vars: { bpm: "120" } }),
        ],
      }),
    );
    render(<RunsPanel />);
    fireEvent.click(gridCell(/Stem Splitter, a.mp3: Failed/));
    const pop = screen.getByRole("dialog", { name: /a.mp3/ });
    expect(within(pop).getByText("Model missing")).toBeTruthy();
    expect(within(pop).getByText("Install the AI engine")).toBeTruthy();
    expect(within(pop).getByText("Split stems")).toBeTruthy();
    expect(within(pop).getByText("a-vocals.wav")).toBeTruthy();
    expect(within(pop).getByText("bpm")).toBeTruthy();

    fireEvent.click(within(pop).getByRole("button", { name: /Show log for Split stems/ }));
    expect(useUI.getState().trayOpen).toBe(true);
    expect(useUI.getState().expandedLogJobId).toBe("j9");

    fireEvent.click(within(pop).getByRole("button", { name: /Open a-vocals.wav/ }));
    expect(h.open).toHaveBeenCalledWith("o1");
  });

  it("reveals files that are not Library outputs by path", () => {
    setRuns(run("r", { items: [item(0, "a.mp3", [cell("s1", CellStatus.CellDone, { files: [file("/lib/x.wav")] }), cell("s2", CellStatus.CellNone)])] }));
    render(<RunsPanel />);
    fireEvent.click(gridCell(/Stem Splitter, a.mp3: Done/));
    const pop = screen.getByRole("dialog");
    expect((within(pop).getByRole("button", { name: /Open x.wav/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(pop).getByRole("button", { name: /: x.wav/ }));
    expect(h.revealPath).toHaveBeenCalledWith("/lib/x.wav");
  });

  it("closes on Escape", () => {
    setRuns(run("r", { items: [item(0, "a.mp3", [cell("s1", CellStatus.CellDone, { message: "All good" }), cell("s2", CellStatus.CellNone)])] }));
    render(<RunsPanel />);
    fireEvent.click(gridCell(/Stem Splitter, a.mp3: Done/));
    expect(screen.getByText("All good")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Needs-you cards", () => {
  const manualRun = () =>
    run("r", {
      status: RunStatus.RunWaiting,
      needsYou: 1,
      steps: [step("s1", "stems"), step("s2", "trimmer", { manual: true, note: "Pick the part" })],
      items: [item(0, "a.mp4", [cell("s1", CellStatus.CellDone), cell("s2", CellStatus.CellWaiting, { wait: WaitKind.WaitManual, inputs: [file("/lib/a.mp4"), file("/lib/b.mp4")], jobIds: ["j1"] })])],
    });

  it("manual: Open <Tool> hands the inputs over; Continue is disabled until an adopted job is done", () => {
    useJobs.setState({ byId: { j1: job("j1", { status: JobStatus.JobRunning }) } });
    setRuns(manualRun());
    render(<RunsPanel />);
    const card = screen.getByRole("region", { name: "Run r · a.mp4" });
    expect(within(card).getByText(/Pick the part/)).toBeTruthy();
    expect((within(card).getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(card).getByRole("button", { name: "Continue with the original file" }));
    expect(h.cont).toHaveBeenCalledWith({ runId: "r", item: 0, stepId: "s2", keep: null, passThrough: true });
    fireEvent.click(within(card).getByRole("button", { name: /^Open / }));
    expect(useUI.getState().handoff).toEqual({ moduleId: "trimmer", inputs: ["/lib/a.mp4", "/lib/b.mp4"] });
  });

  it("manual: Continue works once an adopted job is done; Skip and Stop call their services", () => {
    useJobs.setState({
      byId: { j1: job("j1", { outputs: [{ id: "o", jobId: "j1", moduleId: "trimmer", path: "/lib/clip.mp4", name: "clip (trim).mp4", kind: OutputKind.KindVideo, sizeBytes: 1, createdAt: 1, tags: null, missing: false }] }) },
    });
    setRuns(manualRun());
    render(<RunsPanel />);
    const card = screen.getByRole("region", { name: "Run r · a.mp4" });
    expect(within(card).getByText(/clip \(trim\)\.mp4/)).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Continue with the original file" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Continue" }));
    expect(h.cont).toHaveBeenCalledWith({ runId: "r", item: 0, stepId: "s2", keep: null, passThrough: false });
    fireEvent.click(within(card).getByRole("button", { name: "Skip step" }));
    expect(h.skip).toHaveBeenCalledWith("r", 0, "s2");
    fireEvent.click(within(card).getByRole("button", { name: "Stop this file" }));
    expect(h.stop).toHaveBeenCalledWith("r", 0);
  });

  it("check: thumbnails for images, checkboxes, Continue with the kept subset", async () => {
    setRuns(
      run("r", {
        status: RunStatus.RunWaiting,
        needsYou: 1,
        steps: [step("s1", "stems"), step("s2", "pipelines.check")],
        items: [
          item(3, "photos", [
            cell("s1", CellStatus.CellDone),
            cell("s2", CellStatus.CellWaiting, { wait: WaitKind.WaitCheck, inputs: [file("/lib/1.png", { kind: OutputKind.KindImage, outputId: "o1" }), file("/lib/2.wav")] }),
          ]),
        ],
      }),
    );
    render(<RunsPanel />);
    const card = screen.getByRole("region", { name: "Run r · photos" });
    await waitFor(() => expect(card.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAA"));
    expect(h.thumb).toHaveBeenCalledWith("/lib/1.png", expect.any(Number));
    expect(h.thumb).toHaveBeenCalledTimes(1);
    expect(within(card).getByRole("button", { name: "Continue with 2 files" })).toBeTruthy();
    fireEvent.click(within(card).getByRole("checkbox", { name: "1.png" }));
    fireEvent.click(within(card).getByRole("button", { name: "Continue with 1 file" }));
    expect(h.cont).toHaveBeenCalledWith({ runId: "r", item: 3, stepId: "s2", keep: ["/lib/2.wav"], passThrough: false });
    fireEvent.click(within(card).getByRole("button", { name: "Open 1.png" }));
    expect(h.open).toHaveBeenCalledWith("o1");
    fireEvent.click(within(card).getByRole("button", { name: "Stop this file" }));
    expect(h.stop).toHaveBeenCalledWith("r", 3);
  });
});

describe("Run actions", () => {
  const done = (o: Partial<ReturnType<typeof run>> = {}) =>
    run("r", { status: RunStatus.RunPartial, items: [item(0, "a.mp3", [cell("s1", CellStatus.CellDone, { files: [file("/lib/t.wav", { temporary: true })] }), cell("s2", CellStatus.CellFailed)])], ...o });
  const btn = (n: string) => screen.getByRole("button", { name: n }) as HTMLButtonElement;

  it("active run: Cancel is offered, Remove and Clean are disabled", () => {
    setRuns(run("r", { items: [item(0, "a.mp3", [cell("s1", CellStatus.CellRunning), cell("s2", CellStatus.CellPending)])] }));
    render(<RunsPanel />);
    expect(btn("Retry failed").disabled).toBe(true);
    expect(btn("Delete in-between files").disabled).toBe(true);
    expect(btn("Remove").disabled).toBe(true);
    fireEvent.click(btn("Cancel"));
    expect(h.cancel).toHaveBeenCalledWith("r");
  });

  it("partial run: Retry and Clean are enabled", async () => {
    setRuns(done());
    render(<RunsPanel />);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(btn("Retry failed").disabled).toBe(false);
    expect(btn("Delete in-between files").disabled).toBe(false);
    fireEvent.click(btn("Retry failed"));
    expect(h.retry).toHaveBeenCalledWith("r");
    fireEvent.click(btn("Delete in-between files"));
    expect(h.clean).toHaveBeenCalledWith("r");
    await waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.title)).toContain("Deleted 2 in-between files"));
  });

  it("cleaned run: Retry and Clean are disabled", () => {
    setRuns(done({ cleaned: true }));
    render(<RunsPanel />);
    expect(btn("Retry failed").disabled).toBe(true);
    expect(btn("Delete in-between files").disabled).toBe(true);
  });

  it("done run: nothing to retry", () => {
    setRuns(done({ status: RunStatus.RunDone }));
    render(<RunsPanel />);
    expect(btn("Retry failed").disabled).toBe(true);
  });

  it("Remove confirms with 'also delete in-between files' on by default", async () => {
    setRuns(done());
    render(<RunsPanel />);
    fireEvent.click(btn("Remove"));
    const dlg = screen.getByRole("dialog");
    const box = within(dlg).getByRole("checkbox", { name: "Also delete in-between files" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    fireEvent.click(within(dlg).getByRole("button", { name: "Remove" }));
    expect(h.remove).toHaveBeenCalledWith("r", false);
    await waitFor(() => expect(usePipelines.getState().runs.r).toBeUndefined());
  });
});

describe("RunResults", () => {
  it("lists Keep-step files by item, opens the folder and tabulates variables", async () => {
    setRuns(
      run("r", {
        name: "Podcast",
        status: RunStatus.RunDone,
        steps: [step("s1", "stems"), step("s2", "trimmer", { keep: true })],
        items: [
          item(0, "ep1.mp3", [cell("s1", CellStatus.CellDone, { files: [file("/lib/inter.wav", { temporary: true })] }), cell("s2", CellStatus.CellDone, { files: [file("/lib/final.mp3", { outputId: "o7" })] })], { vars: { bpm: "98", key: "A min" } }),
        ],
      }),
    );
    render(<RunsPanel />);
    const res = screen.getByRole("region", { name: "Results" });
    expect(within(res).getByText("final.mp3")).toBeTruthy();
    expect(within(res).queryByText("inter.wav")).toBeNull();
    const table = within(res).getByRole("table", { name: "Variables" });
    expect(within(table).getByText("98")).toBeTruthy();
    expect(within(table).getByText("A min")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(res).getByRole("button", { name: "Open folder" }));
    });
    expect(h.openFolder).toHaveBeenCalledWith("Pipelines/Podcast");
  });
});
