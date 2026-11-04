import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";

const h = vi.hoisted(() => ({ save: vi.fn(), describe: vi.fn(), setModuleState: vi.fn() }));

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
    SettingsService: { SetModuleState: (...a: unknown[]) => h.setModuleState(...a), ModuleState: async () => "" },
  };
});

import type { BridgeTransport } from "@/state/bridge";
import { hostBridge, resetBridgeStatusesForTest } from "@/state/bridge";
import type { Pipeline } from "@/lib/api";
import { parseWindow, setCurrentWindowForTest } from "@/lib/windows";
import { getPart } from "@/parts/registry";
import { usePipelines } from "@/state/pipelines";
import { setWorkspaceTransportForTest } from "@/workspace/defineWorkspace";
import { useDraft, type DraftState } from "./draftStore";
import { PipelineEditor } from "./PipelineEditor";
import { useEditorModeStore } from "./editorMode";
import { stepsOf } from "./editorModel";
import { flushForPopOut } from "./popoutState";
import { pipelinesBridge, pipelinesWorkspace } from "./workspace";
import { CATALOG, check, entry, pipeline, step, stepCheck } from "./testFixtures";

const A = "aaaaaaaa";
const B = "bbbbbbbb";
const C = "cccccccc";
const base = () => pipeline("p1", [step(A, "downloader"), step(B, "stems", { from: A }), step(C, "trimmer", { from: B })]);

function seed(p: Pipeline) {
  usePipelines.setState({ entries: [entry(p)], catalog: CATALOG, templates: [], runs: {}, loaded: true, selectedPipelineId: p.id });
}

const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers();
  h.setModuleState.mockResolvedValue(undefined);
  h.save.mockImplementation(async (p: Pipeline) => entry(p));
  h.describe.mockImplementation(async (p: Pipeline) => check(stepsOf(p).map((s) => stepCheck(s.id))));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  setWorkspaceTransportForTest(null);
  setCurrentWindowForTest(null);
  resetBridgeStatusesForTest();
  usePipelines.setState({ entries: [], selectedPipelineId: null, runs: {} });
  useEditorModeStore.setState({ mode: null });
  localStorage.removeItem("toolbox.pipelines.editorMode");
});

describe("undo and redo in the editor", () => {
  it("Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y step through list edits; the header buttons do the same", () => {
    localStorage.setItem("toolbox.pipelines.editorMode", "list");
    seed(base());
    render(<PipelineEditor />);
    const undoBtn = screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement;
    const redoBtn = screen.getByRole("button", { name: "Redo" }) as HTMLButtonElement;
    expect(undoBtn.disabled).toBe(true);
    act(() => useDraft.getState().setName("Renamed"));
    expect(undoBtn.disabled).toBe(false);
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    expect(useDraft.getState().draft?.name).toBe(base().name);
    expect(redoBtn.disabled).toBe(false);
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true, shiftKey: true });
    expect(useDraft.getState().draft?.name).toBe("Renamed");
    fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    expect(useDraft.getState().draft?.name).toBe(base().name);
    fireEvent.keyDown(document.body, { key: "y", ctrlKey: true });
    expect(useDraft.getState().draft?.name).toBe("Renamed");
    fireEvent.click(undoBtn);
    expect(useDraft.getState().draft?.name).toBe(base().name);
    fireEvent.click(redoBtn);
    expect(useDraft.getState().draft?.name).toBe("Renamed");
  });

  it("leaves Ctrl+Z to a focused text field", () => {
    localStorage.setItem("toolbox.pipelines.editorMode", "list");
    seed(base());
    render(<PipelineEditor />);
    act(() => useDraft.getState().setName("Renamed"));
    fireEvent.keyDown(screen.getByLabelText("Pipeline name"), { key: "z", ctrlKey: true });
    expect(useDraft.getState().draft?.name).toBe("Renamed");
  });

  it("undoes a deleted graph node", () => {
    seed(base());
    render(<PipelineEditor />);
    const node = document.querySelector<HTMLElement>(`[data-node-id="${B}"]`)!;
    fireEvent.pointerDown(node, { button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(window, { clientX: 5, clientY: 5 });
    fireEvent.keyDown(screen.getByRole("application"), { key: "Delete" });
    expect(stepsOf(useDraft.getState().draft!).map((s) => s.id)).toEqual([A, C]);
    fireEvent.keyDown(screen.getByRole("application"), { key: "z", ctrlKey: true });
    expect(stepsOf(useDraft.getState().draft!).map((s) => s.id)).toEqual([A, B, C]);
  });
});

describe("panels in Graph mode", () => {
  it("edits the description from the About panel", async () => {
    seed(base());
    render(<PipelineEditor onNew={() => undefined} />);
    expect(screen.queryByLabelText("Description")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /About/ }));
    fireEvent.change(screen.getByPlaceholderText("Add a description"), { target: { value: "Cleans up my podcasts" } });
    expect(useDraft.getState().draft?.description).toBe("Cleans up my podcasts");
    await tick(700);
    expect((h.save.mock.calls.at(-1)![0] as Pipeline).description).toBe("Cleans up my podcasts");
  });

  it("shows a node's options in the Step panel from its gear", () => {
    seed(base());
    render(<PipelineEditor onNew={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Options for Video Trimmer" }));
    expect(useDraft.getState().stepId).toBe(C);
    expect(screen.getByRole("dialog", { name: "Step" })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Video Trimmer"), { target: { value: "Cut" } });
    expect(stepsOf(useDraft.getState().draft!).find((s) => s.id === C)?.label).toBe("Cut");
  });
});

/** An in-memory relay: every endpoint hears the others; payloads are JSON round-tripped. */
class Hub {
  subs = new Map<string, Set<(p: unknown, from: string) => void>>();
  endpoint(key: string): BridgeTransport {
    return {
      send: (payload, to = "") => {
        const wire = JSON.parse(JSON.stringify(payload)) as unknown;
        for (const [k, set] of this.subs) {
          if (k === key || (to && to !== k)) continue;
          for (const cb of [...set]) cb(wire, key);
        }
      },
      on: (cb) => {
        const set = this.subs.get(key) ?? new Set();
        set.add(cb);
        this.subs.set(key, set);
        return () => set.delete(cb);
      },
    };
  }
}

describe("the pipelines workspace", () => {
  it("registers Step, Triggers, Runs and About and no preview", () => {
    expect(pipelinesWorkspace.panels.map((p) => p.id)).toEqual(["step", "triggers", "runs", "about"]);
    expect(pipelinesWorkspace.previewPart).toBe("");
    expect(getPart("pipelines.panel")).toBeDefined();
  });

  it("renders the Step panel in a replica and an option edit reaches the host", async () => {
    vi.useRealTimers();
    const hub = new Hub();
    setWorkspaceTransportForTest(() => hub.endpoint("replica"));
    setCurrentWindowForTest(parseWindow("?window=part&part=pipelines.panel&panel=step&key=part:pipelines.panel@step"));
    // The host: the same shape as the draft store, its own instance.
    const p = base();
    const host = createStore<DraftState>((set, get) => ({
      ...(useDraft.getState() as DraftState),
      pipelineId: "p1",
      draft: p,
      check: check(stepsOf(p).map((s) => stepCheck(s.id))),
      catalog: CATALOG,
      stepId: C,
      patchStep: (id, patch) => set({ draft: { ...get().draft!, steps: stepsOf(get().draft!).map((s) => (s.id === id ? { ...s, ...patch } : s)) } }),
    }));
    const stop = hostBridge(host, { name: pipelinesWorkspace.bridgeName, ...pipelinesBridge }, hub.endpoint("host"));
    const part = getPart("pipelines.panel")!;
    const disconnect = await part.connect!(new URLSearchParams("panel=step"));
    const Part = part.component;
    render(<Part placement="window" />);
    const input = await screen.findByPlaceholderText("Video Trimmer");
    fireEvent.change(input, { target: { value: "Cut" } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(stepsOf(host.getState().draft!).find((s) => s.id === C)?.label).toBe("Cut");
    // The replica never saves.
    expect(h.save).not.toHaveBeenCalled();
    disconnect();
    stop();
    useDraft.setState({ draft: null, pipelineId: null, stepId: null });
  });
});

describe("popping the tool out", () => {
  it("saves a dirty draft and remembers which pipeline was open", async () => {
    seed(base());
    render(<PipelineEditor />);
    act(() => useDraft.getState().setName("Before pop-out"));
    expect(h.save).not.toHaveBeenCalled();
    await act(async () => {
      await flushForPopOut();
    });
    expect((h.save.mock.calls.at(-1)![0] as Pipeline).name).toBe("Before pop-out");
    expect(JSON.parse(h.setModuleState.mock.calls.at(-1)![1] as string)).toEqual({ pipelineId: "p1" });
  });

  it("keeps a draft that can't be saved yet in the module state", async () => {
    seed(base());
    h.save.mockRejectedValue({ message: "Name already used" });
    render(<PipelineEditor />);
    act(() => useDraft.getState().setName("Taken"));
    await act(async () => {
      await flushForPopOut();
    });
    const kept = JSON.parse(h.setModuleState.mock.calls.at(-1)![1] as string) as { pipelineId: string; draft: Pipeline };
    expect(kept.pipelineId).toBe("p1");
    expect(kept.draft.name).toBe("Taken");
  });
});
