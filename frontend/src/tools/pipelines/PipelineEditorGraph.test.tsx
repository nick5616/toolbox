import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ save: vi.fn(), describe: vi.fn() }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    PipelinesService: {
      Save: (...a: unknown[]) => h.save(...a),
      Describe: (...a: unknown[]) => h.describe(...a),
      List: async () => [],
      Runs: async () => [],
      Catalog: async () => [],
      Templates: async () => [],
    },
    FilesService: { PickFolder: async () => "" },
  };
});

import type { Pipeline } from "@/lib/api";
import { usePipelines } from "@/state/pipelines";
import { PipelineEditor } from "./PipelineEditor";
import { useEditorModeStore } from "./editorMode";
import { stepsOf } from "./editorModel";
import { CATALOG, check, entry, pipeline, step, stepCheck } from "./testFixtures";

const A = "aaaaaaaa";
const B = "bbbbbbbb";
const C = "cccccccc";
const MODE = "toolbox.pipelines.editorMode";

const base = () => pipeline("p1", [step(A, "downloader", { keep: false }), step(B, "stems", { from: A }), step(C, "trimmer", { from: B, keep: true })]);

function seed(p: Pipeline) {
  usePipelines.setState({ entries: [entry(p)], catalog: CATALOG, templates: [], runs: {}, loaded: true, selectedPipelineId: p.id });
}

const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const lastSaved = (): Pipeline => h.save.mock.calls[h.save.mock.calls.length - 1]![0] as Pipeline;
const node = (id: string) => document.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;

beforeEach(() => {
  vi.useFakeTimers();
  h.save.mockImplementation(async (p: Pipeline) => entry(p));
  h.describe.mockImplementation(async (p: Pipeline) => check(stepsOf(p).map((s) => stepCheck(s.id))));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  localStorage.removeItem(MODE);
  usePipelines.setState({ entries: [], selectedPipelineId: null, runs: {} });
  useEditorModeStore.setState({ mode: null });
});

describe("PipelineEditor List | Graph", () => {
  it("opens on Graph when nothing is remembered, and remembers the choice", () => {
    seed(base());
    render(<PipelineEditor />);
    expect(screen.getByRole("application")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Steps" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "List" }));
    expect(screen.getByRole("list", { name: "Steps" })).toBeTruthy();
    expect(screen.queryByRole("application")).toBeNull();
    expect(localStorage.getItem(MODE)).toBe("list");
  });

  it("round-trips: a wire made in the graph shows in the list and saves its layout", async () => {
    seed(base());
    render(<PipelineEditor />);
    const port = document.querySelector<HTMLElement>(`[data-node="${A}"][data-out-port="*"]`)!;
    // Rewire the trimmer (step 3) to read the downloader instead of the stems.
    act(() => {
      fireEvent.pointerDown(port, { button: 0, clientX: 5, clientY: 5 });
      fireEvent.pointerMove(window, { clientX: 90, clientY: 90 });
      fireEvent.pointerUp(node(C), { clientX: 99, clientY: 99 });
    });
    fireEvent.click(screen.getByRole("radio", { name: "List" }));
    const card = screen.getByRole("region", { name: /Step \d: Video Trimmer/ });
    expect(card.getAttribute("data-step-id")).toBe(C);
    await tick(700);
    const saved = lastSaved();
    expect(stepsOf(saved).find((s) => s.id === C)?.from).toBe(A);
    expect((JSON.parse(saved.layout) as { nodes: Record<string, unknown> }).nodes[C]).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Graph" }));
    expect(document.querySelector(`[data-wire-id="${A}|*|${C}"]`)).toBeTruthy();
  });

  it("keeps panels (step, triggers, runs, about) behind click-ins in Graph mode, with summaries", () => {
    seed(pipeline("p1", base().steps ?? [], { watch: { enabled: true, folder: "C:/Users/me/Inbox" } }));
    render(<PipelineEditor />);
    expect(screen.queryByRole("region", { name: "Triggers" })).toBeNull();
    const trig = screen.getByRole("button", { name: /Triggers/ });
    expect(trig.textContent).toMatch(/Watching Inbox/);
    expect(screen.getByRole("button", { name: /Runs/ }).textContent).toMatch(/no runs yet/);
    fireEvent.click(trig);
    expect(screen.getByText(/Watch a folder/)).toBeTruthy();
  });

  it("shows live status counts on nodes while a run is active", () => {
    seed(base());
    const cell = (stepId: string, status: string) => ({ stepId, status, wait: "", jobIds: [], inputs: [], files: [] });
    usePipelines.setState({
      runs: {
        r1: {
          id: "r1",
          pipelineId: "p1",
          status: "running",
          createdAt: 1,
          steps: [],
          inputs: [],
          items: [
            { index: 0, label: "a", input: "", merged: [], vars: {}, cells: [cell(A, "done"), cell(B, "running")] },
            { index: 1, label: "b", input: "", merged: [], vars: {}, cells: [cell(A, "running"), cell(B, "pending")] },
          ],
        } as never,
      },
    });
    render(<PipelineEditor />);
    expect(screen.getByText("1 running · 1 done")).toBeTruthy();
  });
});
