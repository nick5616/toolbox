import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/viz/edit/EditCanvas", () => ({ EditCanvas: () => <div data-testid="canvas" /> }));
vi.mock("./overlays/PreviewOverlays", () => ({ PreviewOverlays: () => <div data-testid="overlays" /> }));

import { PLAIN_PROFILE } from "./profileContext";
import { getPart } from "@/parts/registry";
import { parseWindow, setCurrentWindowForTest } from "@/lib/windows";
import { resetBridgeStatusesForTest, type BridgeTransport } from "@/state/bridge";
import { normalizeProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import { setReplicaModeForTest, startEditorReplica, type EditorBridgeValues } from "./bridge";
import { estimateTime, makeEditorParts, PanelPart, PreviewPart } from "./editorParts";
import { registerEditorPanel } from "./panels";
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

describe("editor parts", () => {
  let dispose: () => void = () => undefined;
  beforeEach(() => {
    resetBridgeStatusesForTest();
    useEditStudio.getState().close();
  });
  afterEach(() => {
    dispose();
    cleanup();
    setReplicaModeForTest(false);
    setCurrentWindowForTest(null);
  });

  const connect = (values: Partial<EditorBridgeValues>) => {
    const host = fakeHost({ projectId: "p1", name: "x", project: doc, undoDepth: 0, redoDepth: 0, playheadMs: 0, playing: false, ...values });
    dispose = startEditorReplica("video-studio", { editor: host.t, focus: focusHost() });
    return host;
  };

  it("registers a preview and a panel part for the tool", () => {
    makeEditorParts("video-studio", PLAIN_PROFILE);
    const preview = getPart("video-studio.preview");
    const panel = getPart("video-studio.panel");
    expect(preview).toMatchObject({ host: "video-studio", width: 960, height: 600 });
    expect(panel).toMatchObject({ host: "video-studio", width: 380, height: 720 });
    expect(preview?.connect).toBeTypeOf("function");
  });

  it("preview shows Connecting until live, then the canvas and a mini transport that forwards to the host", async () => {
    const host = connect({ playheadMs: 2500 });
    render(<PreviewPart profile={PLAIN_PROFILE} />);
    expect(screen.getByText("Connecting…")).toBeTruthy();
    await flush();
    expect(screen.getByTestId("canvas")).toBeTruthy();
    expect(screen.getByTestId("overlays")).toBeTruthy();
    expect(screen.getByLabelText("Time").textContent).toContain("0:02.5");
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(host.calls).toContainEqual({ action: "setPlaying", args: [true] });
  });

  it("forwards Space, frame steps and undo/redo to the host", async () => {
    const host = connect({ playheadMs: 1000, undoDepth: 1 });
    render(<PreviewPart profile={PLAIN_PROFILE} />);
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

  it("a panel part renders the registered panel against the replica", async () => {
    registerEditorPanel({ id: "t-panel", title: "T", icon: "x", tip: "t", component: () => <div>{`panel:${useEditStudio.getState().name}`}</div> });
    setCurrentWindowForTest(parseWindow("?window=part&part=video-studio.panel&panel=t-panel&key=part:video-studio.panel"));
    connect({ name: "Hello" });
    render(<PanelPart profile={PLAIN_PROFILE} />);
    await flush();
    expect(screen.getByText("panel:Hello")).toBeTruthy();
  });

  it("an unknown panel id shows an empty state", async () => {
    setCurrentWindowForTest(parseWindow("?window=part&part=video-studio.panel&panel=nope&key=part:video-studio.panel"));
    connect({});
    render(<PanelPart profile={PLAIN_PROFILE} />);
    await flush();
    expect(screen.getByText("This panel doesn't exist.")).toBeTruthy();
  });

  it("the focus store replica is started too", async () => {
    connect({});
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
