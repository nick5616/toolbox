import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/viz/edit/EditCanvas", () => ({ EditCanvas: () => <div data-testid="canvas" /> }));
vi.mock("./overlays/PreviewOverlays", () => ({ PreviewOverlays: () => <div data-testid="overlays" /> }));

import type { ComponentType } from "react";
import type { PartProps } from "@/parts/types";
import { setWorkspaceTransportForTest } from "@/workspace/defineWorkspace";
import { PLAIN_PROFILE } from "./profileContext";
import { getPart } from "@/parts/registry";
import { parseWindow, setCurrentWindowForTest } from "@/lib/windows";
import { resetBridgeStatusesForTest, type BridgeTransport } from "@/state/bridge";
import { normalizeProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import { isReplicaWindow, setReplicaModeForTest, type EditorBridgeValues } from "./bridge";
import { estimateTime } from "./editorParts";
import { defineEditorWorkspace } from "./workspace";
import { useEditorFocus } from "./focus";
import { useEditStudio } from "./store";

/** A host that answers hello with a snapshot and records forwarded calls. */
function fakeHost(values: Partial<EditorBridgeValues>) {
  const calls: { action: string; args: unknown[] }[] = [];
  let listener: ((p: unknown, from: string) => void) | null = null;
  const t: BridgeTransport = {
    send: (p) => {
      const m = p as { t: string; action?: string; args?: unknown[] };
      if (m.t === "hello") queueMicrotask(() => listener?.({ t: "snap", seq: 0, values }, "main"));
      if (m.t === "call") calls.push({ action: m.action ?? "", args: m.args ?? [] });
    },
    on: (cb) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
  };
  return { t, calls };
}

const focusHost = (): BridgeTransport => ({
  send: () => undefined,
  on: (cb) => {
    queueMicrotask(() => cb({ t: "snap", seq: 0, values: { focus: "compose" } }, "main"));
    return () => undefined;
  },
});

const doc = normalizeProject(fixtureProject());
const flush = () => act(async () => void (await Promise.resolve()));

const T_PANEL = { id: "t-panel", title: "T", icon: "x", tip: "t", component: () => <div>{`panel:${useEditStudio.getState().name}`}</div> };
const videoWs = defineEditorWorkspace(PLAIN_PROFILE);
const testWs = defineEditorWorkspace({ ...PLAIN_PROFILE, moduleId: "parts-test", panels: [T_PANEL] });

describe("editor parts", () => {
  let dispose: () => void = () => undefined;
  beforeEach(() => {
    resetBridgeStatusesForTest();
    useEditStudio.getState().close();
  });
  afterEach(() => {
    dispose();
    cleanup();
    setWorkspaceTransportForTest(null);
    setReplicaModeForTest(false);
    setCurrentWindowForTest(null);
  });

  /** Connects the part's replica to a fake host (the way the part window does) and renders the part. */
  const mount = (partId: string, values: Partial<EditorBridgeValues>) => {
    const host = fakeHost({ projectId: "p1", name: "x", project: doc, undoDepth: 0, redoDepth: 0, playheadMs: 0, playing: false, ...values });
    setWorkspaceTransportForTest((_side, name) => (name === "editor-focus" ? focusHost() : host.t));
    const part = getPart(partId)!;
    void part.connect!(new URLSearchParams()).then((d) => {
      dispose = d;
    });
    const Part = part.component as ComponentType<PartProps>;
    render(<Part placement="window" />);
    return host;
  };

  it("registers a preview and a panel part for the tool", () => {
    const preview = getPart("video-studio.preview");
    const panel = getPart("video-studio.panel");
    expect(preview).toMatchObject({ host: "video-studio", width: 960, height: 600 });
    expect(panel).toMatchObject({ host: "video-studio", width: 380, height: 720 });
    expect(preview?.connect).toBeTypeOf("function");
    expect(videoWs.previewPart).toBe("video-studio.preview");
  });

  it("the Video Editor and Edit Studio share one bridge channel per store", () => {
    const edit = defineEditorWorkspace({ ...PLAIN_PROFILE, moduleId: "edit-studio" });
    expect(edit.bridgeName).toBe(videoWs.bridgeName);
    expect(edit.bridgeName).toBe("editor");
    expect(edit.panelPart).toBe("edit-studio.panel");
  });

  it("preview shows Connecting until live, then the canvas and a mini transport that forwards to the host", async () => {
    setCurrentWindowForTest(parseWindow("?window=part&part=video-studio.preview&key=part:video-studio.preview"));
    const host = mount("video-studio.preview", { playheadMs: 2500 });
    expect(screen.getByText("Connecting…")).toBeTruthy();
    await flush();
    expect(screen.getByTestId("canvas")).toBeTruthy();
    expect(screen.getByTestId("overlays")).toBeTruthy();
    expect(screen.getByLabelText("Time").textContent).toContain("0:02.5");
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(host.calls).toContainEqual({ action: "setPlaying", args: [true] });
  });

  it("forwards Space, frame steps and undo/redo to the host", async () => {
    setCurrentWindowForTest(parseWindow("?window=part&part=video-studio.preview&key=part:video-studio.preview"));
    const host = await mount("video-studio.preview", { playheadMs: 1000, undoDepth: 1 });
    await flush();
    const key = (init: KeyboardEventInit) => fireEvent.keyDown(window, init);
    key({ key: " " });
    key({ key: "ArrowRight" });
    key({ key: "ArrowLeft" });
    key({ key: "z", ctrlKey: true });
    key({ key: "z", ctrlKey: true, shiftKey: true });
    const names = host.calls.map((c) => c.action);
    expect(names).toEqual(["setPlaying", "setPlayhead", "setPlayhead", "undo", "redo"]);
    const fps = doc.fps;
    expect(host.calls[1]?.args[0]).toBeCloseTo(1000 + 1000 / fps, 0);
    expect(host.calls[2]?.args[0]).toBeCloseTo(1000 - 1000 / fps, 0);
  });

  it("a panel part renders the tool's panel against the replica", async () => {
    expect(testWs.getPanel("t-panel")).toBeTruthy();
    setCurrentWindowForTest(parseWindow("?window=part&part=parts-test.panel&panel=t-panel&key=part:parts-test.panel"));
    await mount("parts-test.panel", { name: "Hello" });
    await flush();
    expect(screen.getByText("panel:Hello")).toBeTruthy();
  });

  it("an unknown panel id shows an empty state", async () => {
    setCurrentWindowForTest(parseWindow("?window=part&part=video-studio.panel&panel=nope&key=part:video-studio.panel"));
    await mount("video-studio.panel", {});
    await flush();
    expect(screen.getByText("This panel doesn't exist.")).toBeTruthy();
  });

  it("the replica rebuilds the undo/redo depth placeholders and enters replica mode", async () => {
    setCurrentWindowForTest(parseWindow("?window=part&part=parts-test.panel&panel=t-panel&key=part:parts-test.panel"));
    await mount("parts-test.panel", { undoDepth: 3, redoDepth: 2 });
    await flush();
    expect(useEditStudio.getState().history?.past).toHaveLength(3);
    expect(useEditStudio.getState().history?.future).toHaveLength(2);
    expect(isReplicaWindow()).toBe(true);
  });

  it("the focus store replica is started too", async () => {
    setCurrentWindowForTest(parseWindow("?window=part&part=video-studio.panel&panel=media&key=part:video-studio.panel"));
    await mount("video-studio.panel", {});
    await flush();
    expect(useEditorFocus.getState().focus).toBe("compose");
  });
});

describe("estimateTime", () => {
  it("extrapolates from the patch, never steps back by latency and snaps on seeks", () => {
    expect(estimateTime({ ms: 1000, elapsedMs: 16 }, 1000, 0)).toBe(1016);
    expect(estimateTime({ ms: 1010, elapsedMs: 0 }, 1030, 0)).toBe(1030); // a late patch: keep going
    expect(estimateTime({ ms: 5000, elapsedMs: 0 }, 1030, 0)).toBe(5000); // a seek
    expect(estimateTime({ ms: 1000, elapsedMs: 0 }, 5000, 0)).toBe(1000); // a seek back
    expect(estimateTime({ ms: 4990, elapsedMs: 100 }, 4990, 5000)).toBe(5000); // clamped to the length
  });
});
