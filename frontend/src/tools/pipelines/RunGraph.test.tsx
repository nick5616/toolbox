import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ cont: vi.fn(), skip: vi.fn(), stop: vi.fn(), match: vi.fn() }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    PipelinesService: {
      Cancel: async () => undefined,
      Retry: async () => undefined,
      CleanUp: async () => 0,
      Remove: async () => undefined,
      Continue: (...a: unknown[]) => h.cont(...a),
      SkipStep: (...a: unknown[]) => h.skip(...a),
      StopItem: (...a: unknown[]) => h.stop(...a),
      List: async () => [],
      Runs: async () => [],
      Catalog: async () => [],
      Templates: async () => [],
    },
    FilesService: { ImageThumb: async () => "" },
    LibraryService: { OpenLibraryFolder: async () => undefined, Open: async () => undefined, Reveal: async () => undefined, RevealPath: async () => undefined },
    ModulesService: { Match: (...a: unknown[]) => h.match(...a) },
  };
});

import { CellStatus, RunStatus, WaitKind } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import { usePipelines } from "@/state/pipelines";
import { useUI } from "@/state/ui";
import { RUN_MODE_KEY, useRunModeStore } from "./RunGraphMode";
import { RunsPanel } from "./RunsPanel";
import { cell, file, item, run } from "./RunGridFixtures";
import { CATALOG, entry, pipeline, step } from "./testFixtures";

const steps = [step("s1", "stems"), step("s2", "trimmer", { from: "s1", manual: true })];

function setRuns(...runs: ReturnType<typeof run>[]) {
  usePipelines.setState({ runs: {}, selectedRunId: null, runFilter: "", tab: "runs" });
  usePipelines.getState().setRuns(runs);
}

const sample = () =>
  run("r1", {
    name: "Sample run",
    steps,
    needsYou: 1,
    items: [
      item(0, "a.mp3", [cell("s1", CellStatus.CellDone, { files: [file("/o/a-vocals.wav")] }), cell("s2", CellStatus.CellWaiting, { wait: WaitKind.WaitManual, inputs: [file("/o/a-vocals.wav")] })]),
      item(1, "b.mp3", [cell("s1", CellStatus.CellFailed, { error: "Stem model missing", errorHint: "Install the AI engine" }), cell("s2", CellStatus.CellBlocked)]),
    ],
  });

beforeEach(() => {
  localStorage.clear();
  useRunModeStore.setState({ mode: null });
  for (const m of [h.cont, h.skip, h.stop]) m.mockResolvedValue(undefined);
  h.match.mockResolvedValue({ matches: [], unmatched: [] });
  useJobs.setState({ byId: {}, logs: {}, logsLoaded: {} });
  usePipelines.setState({ entries: [entry(pipeline("p1", steps, { name: "Stems" }))], catalog: CATALOG });
  useUI.setState({ trayOpen: false, expandedLogJobId: null, handoff: null, view: "pipelines" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Runs graph", () => {
  it("shows the run as a graph by default, with each step's counts", () => {
    setRuns(sample());
    render(<RunsPanel />);
    expect(screen.getByRole("application", { name: /Run graph/ })).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Run progress" })).toBeNull();
    const stems = screen.getByRole("group", { name: "Stem Splitter node" });
    expect(within(stems).getByText("1 done · 1 failed")).toBeTruthy();
    expect(within(stems).getByText("Stem model missing")).toBeTruthy();
    expect(within(stems).getByText("1 file")).toBeTruthy();
    const trim = screen.getByRole("group", { name: "Video Trimmer node" });
    expect(within(trim).getByText("1 need you · 1 failed")).toBeTruthy();
  });

  it("switches to the list and remembers the choice", () => {
    setRuns(sample());
    const { unmount } = render(<RunsPanel />);
    expect(screen.getByRole("radio", { name: "Graph" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "List" }));
    expect(screen.getByRole("table", { name: "Run progress" })).toBeTruthy();
    expect(screen.queryByRole("application", { name: /Run graph/ })).toBeNull();
    expect(localStorage.getItem(RUN_MODE_KEY)).toBe("list");
    unmount();
    useRunModeStore.setState({ mode: null });
    render(<RunsPanel />);
    expect(screen.getByRole("table", { name: "Run progress" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Graph" }));
    expect(screen.getByRole("application", { name: /Run graph/ })).toBeTruthy();
    expect(localStorage.getItem(RUN_MODE_KEY)).toBe("graph");
  });

  it("a node click lists the step's cells with error and files", () => {
    setRuns(sample());
    render(<RunsPanel />);
    fireEvent.pointerDown(screen.getByRole("group", { name: "Stem Splitter node" }), { button: 0 });
    const panel = screen.getByRole("complementary", { name: "Stem Splitter: files and progress" });
    const a = within(panel).getByRole("region", { name: "a.mp3: Done" });
    expect(within(a).getByText("a-vocals.wav")).toBeTruthy();
    expect(within(a).getByRole("button", { name: /Send a-vocals.wav to/ })).toBeTruthy();
    const b = within(panel).getByRole("region", { name: "b.mp3: Failed" });
    expect(within(b).getByText("Stem model missing")).toBeTruthy();
    expect(within(b).getByText("Install the AI engine")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Close step details" }));
    expect(screen.queryByRole("complementary", { name: /files and progress/ })).toBeNull();
  });

  it("a waiting step shows Continue and Skip in its panel", () => {
    setRuns(sample());
    render(<RunsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "1 step needs you" }));
    const panel = screen.getByRole("complementary", { name: "Video Trimmer: files and progress" });
    fireEvent.click(within(panel).getByRole("button", { name: "Continue with the original file" }));
    expect(h.cont).toHaveBeenCalledWith({ runId: "r1", item: 0, stepId: "s2", keep: null, passThrough: true });
    fireEvent.click(within(panel).getByRole("button", { name: "Skip step" }));
    expect(h.skip).toHaveBeenCalledWith("r1", 0, "s2");
    expect(within(panel).getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("shows a progress bar on a running step", () => {
    setRuns(run("r2", { steps, status: RunStatus.RunRunning, items: [item(0, "a.mp3", [cell("s1", CellStatus.CellRunning), cell("s2", CellStatus.CellPending)])] }));
    render(<RunsPanel />);
    const stems = screen.getByRole("group", { name: "Stem Splitter node" });
    expect(within(stems).getByRole("progressbar", { name: "Step progress" })).toBeTruthy();
    const trim = screen.getByRole("group", { name: "Video Trimmer node" });
    expect(within(trim).queryByRole("progressbar")).toBeNull();
    expect(within(trim).getByText("Not started")).toBeTruthy();
  });
});
