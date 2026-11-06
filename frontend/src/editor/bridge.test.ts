import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";

const h = vi.hoisted(() => ({
  sources: vi.fn(async () => []),
  mattes: vi.fn(async () => []),
  analysis: vi.fn(async () => ({ key: "a1", audioJson: "/a.json", featuresPath: "/f.bin", textJson: "" })),
  save: vi.fn(async () => undefined),
  urlFor: vi.fn(async (p: string) => `/media/t/${p}`),
  loadAnalysis: vi.fn(async () => ({ fake: true })),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    EditStudioService: { Sources: h.sources, Mattes: h.mattes, Analysis: h.analysis, Save: h.save },
    MediaService: { URLFor: h.urlFor },
  };
});
vi.mock("@/viz/analysis", () => ({ loadAnalysis: h.loadAnalysis }));

import { renderHook, waitFor } from "@testing-library/react";
import { PATCH_INTERVAL_MS, resetBridgeStatusesForTest, type BridgeTransport } from "@/state/bridge";
import { useWindows } from "@/state/windows";
import { hostBridge, replicaBridge } from "@/state/bridge";
import { normalizeProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import { withClip } from "./doc";
import { editorBridgeSpec, focusBridgeSpec, isReplicaWindow, setReplicaModeForTest } from "./bridge";
import { useEditorFocus } from "./focus";
import { useEditStudio, type EditStudioState } from "./store";
import { useEditData } from "./useEditData";

class Hub {
  endpoints = new Map<string, Set<(p: unknown, from: string) => void>>();
  endpoint(key: string): BridgeTransport {
    return {
      send: (payload, to = "") => {
        const wire = JSON.parse(JSON.stringify(payload)) as unknown;
        for (const [k, subs] of this.endpoints) {
          if (k === key || (to && to !== k)) continue;
          for (const cb of [...subs]) cb(wire, key);
        }
      },
      on: (cb) => {
        const set = this.endpoints.get(key) ?? new Set();
        set.add(cb);
        this.endpoints.set(key, set);
        return () => set.delete(cb);
      },
    };
  }
}

/** A second copy of the editor store: the singleton's initial values; its listed actions are replaced by forwarders. */
const replicaStore = () => createStore<EditStudioState>(() => ({ ...useEditStudio.getInitialState() }));

describe("editor store bridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWindows.setState({ open: [] });
    resetBridgeStatusesForTest();
    useEditStudio.getState().close();
    useEditorFocus.setState({ focus: "compose" });
  });
  afterEach(() => {
    vi.useRealTimers();
    setReplicaModeForTest(false);
  });

  it("round trips edits, undo, selection and focus between host and replica", () => {
    const hub = new Hub();
    const doc = normalizeProject(fixtureProject());
    useEditStudio.getState().open("p1", "My edit", doc);
    const offHost = hostBridge(useEditStudio, editorBridgeSpec("edit-studio"), hub.endpoint("main"));
    const offFocusHost = hostBridge(useEditorFocus, focusBridgeSpec("edit-studio"), hub.endpoint("main-focus"));

    const rep = replicaStore();
    replicaBridge(rep, editorBridgeSpec("edit-studio"), { transport: hub.endpoint("part:a") });
    expect(rep.getState().projectId).toBe("p1");
    expect(rep.getState().name).toBe("My edit");
    expect(rep.getState().history?.present).toEqual(doc);
    expect(rep.getState().history?.past).toHaveLength(0);

    // an edit in the replica runs on the host, history grows there, the replica sees the new project
    const next = withClip(doc, "c1", { volume: 2 });
    rep.getState().edit(next, "vol");
    expect(useEditStudio.getState().history?.past).toHaveLength(1);
    expect(useEditStudio.getState().history?.present).toEqual(normalizeProject(next));
    vi.advanceTimersByTime(PATCH_INTERVAL_MS);
    expect(rep.getState().history?.present).toEqual(useEditStudio.getState().history?.present);
    expect(rep.getState().history?.past).toHaveLength(1);
    expect(rep.getState().saveState).toBe("dirty");

    // undo is forwarded
    rep.getState().undo();
    vi.advanceTimersByTime(PATCH_INTERVAL_MS);
    expect(useEditStudio.getState().history?.present).toEqual(doc);
    expect(rep.getState().history?.present).toEqual(doc);
    expect(rep.getState().history?.future).toHaveLength(1);
    rep.getState().redo();
    vi.advanceTimersByTime(PATCH_INTERVAL_MS);
    expect(rep.getState().history?.future).toHaveLength(0);

    // selection syncs both ways
    rep.getState().select({ kind: "clips", ids: ["c2"] });
    expect(useEditStudio.getState().selection).toEqual({ kind: "clips", ids: ["c2"] });
    useEditStudio.getState().select({ kind: "song" });
    vi.advanceTimersByTime(PATCH_INTERVAL_MS);
    expect(rep.getState().selection).toEqual({ kind: "song" });

    // playback and view controls
    rep.getState().setPlaying(true);
    rep.getState().setPlayhead(1234);
    expect(useEditStudio.getState().playing).toBe(true);
    expect(useEditStudio.getState().playheadMs).toBe(1234);
    vi.advanceTimersByTime(PATCH_INTERVAL_MS);
    expect(rep.getState().playheadMs).toBe(1234);

    // the focus store bridges too
    const repFocus = createStore(() => ({ ...useEditorFocus.getInitialState() }));
    replicaBridge(repFocus, focusBridgeSpec("edit-studio"), { transport: hub.endpoint("part:b") });
    repFocus.getState().setFocus("video");
    expect(useEditorFocus.getState().focus).toBe("video");
    vi.advanceTimersByTime(PATCH_INTERVAL_MS);
    expect(repFocus.getState().focus).toBe("video");

    offHost();
    offFocusHost();
  });

  it("reports lost when the project closes on the host", () => {
    const hub = new Hub();
    useEditStudio.getState().open("p1", "x", normalizeProject(fixtureProject()));
    const off = hostBridge(useEditStudio, editorBridgeSpec("m"), hub.endpoint("main"));
    const rep = replicaStore();
    replicaBridge(rep, editorBridgeSpec("m"), { transport: hub.endpoint("part:a") });
    useEditStudio.getState().close();
    vi.advanceTimersByTime(PATCH_INTERVAL_MS);
    expect(rep.getState().projectId).toBeNull();
    expect(rep.getState().history).toBeNull();
    off();
  });

  it("applies the analysis ref and drops a stale analysis", () => {
    const rep = replicaStore();
    const spec = editorBridgeSpec("m");
    const refA = { key: "a1", audioJson: "/a", featuresPath: "/f", textJson: "" } as unknown as NonNullable<EditStudioState["analysisRef"]>;
    spec.apply(rep, { analysisRef: refA });
    rep.setState({ analysis: { fake: true } as unknown as EditStudioState["analysis"] });
    spec.apply(rep, { analysisRef: refA, playheadMs: 5 }); // same key keeps it
    expect(rep.getState().analysis).not.toBeNull();
    spec.apply(rep, { analysisRef: { ...refA, key: "a2" } });
    expect(rep.getState().analysis).toBeNull();
  });
});

describe("useEditData in replica mode", () => {
  beforeEach(() => {
    for (const f of [h.sources, h.mattes, h.analysis, h.save, h.loadAnalysis]) f.mockClear();
    useEditStudio.getState().close();
  });
  afterEach(() => setReplicaModeForTest(false));

  it("loads the analysis from the replicated ref and never calls the host's services", async () => {
    setReplicaModeForTest(true);
    expect(isReplicaWindow()).toBe(true);
    const doc = normalizeProject({ ...fixtureProject(), analysisKey: "a1" });
    useEditStudio.getState().open("p1", "x", doc);
    useEditStudio.setState({ analysisRef: { key: "a1", audioJson: "/a", featuresPath: "/f", textJson: "" } as unknown as EditStudioState["analysisRef"], analysisState: "ready" });
    renderHook(() => useEditData());
    await waitFor(() => expect(useEditStudio.getState().analysis).not.toBeNull());
    expect(h.loadAnalysis).toHaveBeenCalledTimes(1);
    expect(h.sources).not.toHaveBeenCalled();
    expect(h.mattes).not.toHaveBeenCalled();
    expect(h.analysis).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  it("the host mode still refreshes sources and mattes", async () => {
    const doc = normalizeProject(fixtureProject());
    useEditStudio.getState().open("p1", "x", doc);
    renderHook(() => useEditData());
    await waitFor(() => expect(h.sources).toHaveBeenCalled());
  });
});
