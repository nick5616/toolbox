import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  takeHandoff: vi.fn<(key: string) => Promise<string>>(() => Promise.resolve("")),
  popOut: vi.fn((_r: unknown) => Promise.resolve()),
  handlers: new Map<string, (d: unknown) => void>(),
  relaySend: vi.fn(async (_c: string, _p: unknown, _to?: string) => undefined),
  relayListeners: new Set<(m: { channel: string; from: string; to: string; payload: unknown }) => void>(),
}));

vi.mock("@/lib/api", async (orig) => {
  const real = await orig<typeof import("@/lib/api")>();
  return { ...real, DesktopService: { ...real.DesktopService, TakeHandoff: h.takeHandoff, PopOut: h.popOut, ShowMain: vi.fn(() => Promise.resolve()), CloseWindow: vi.fn(() => Promise.resolve()) } };
});
vi.mock("@/lib/events", () => ({
  on: (name: string, cb: (d: unknown) => void) => {
    h.handlers.set(name, cb);
    return () => h.handlers.delete(name);
  },
}));
vi.mock("@/lib/windows", async (orig) => {
  const real = await orig<typeof import("@/lib/windows")>();
  return {
    ...real,
    relaySend: (c: string, p: unknown, to?: string) => h.relaySend(c, p, to),
    relayOn: (_c: string, cb: (m: { channel: string; from: string; to: string; payload: unknown }) => void) => {
      h.relayListeners.add(cb);
      return () => h.relayListeners.delete(cb);
    },
  };
});
vi.mock("@/tools", () => ({
  shellOverlays: [],
  toolViews: {
    stems: () => {
      return <FakeStems />;
    },
  },
  popupViews: {},
}));
vi.mock("@/viz/RenderHost", () => ({ default: () => null }));

import { Category, ModuleStatus, type Descriptor } from "@/lib/api";
import { useEmbed } from "@/lib/embed";
import { registerToolViews } from "@/lib/toolActions";
import { parseWindow, setCurrentWindowForTest } from "@/lib/windows";
import { ClickInHost } from "@/components";
import { useCompositionInputs } from "@/state/composition";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { CompositionBar } from "./CompositionBar";
import { ConstituentDrawer } from "./ConstituentDrawer";
import { ToolWindowShell, resetInitialHandoffForTest } from "./ToolWindowShell";

function FakeStems() {
  const e = useEmbed();
  return (
    <div>
      <p>stems view {e ? `embedded:${e.handoff.inputs.join(",")}` : "standalone"}</p>
      {e?.onUse ? <button onClick={() => e.onUse?.(["/out/vocals.flac"])}>{e.useLabel}</button> : null}
    </div>
  );
}

function mod(id: string, name: string, extra: Partial<Descriptor> = {}): Descriptor {
  return {
    id, name, tagline: "", description: "", icon: "box", category: Category.$zero, status: ModuleStatus.StatusReady,
    accepts: { extensions: [".mp3"], urls: false, any: false }, requires: null, recommends: null, outputSubdir: "", order: 1, hidden: false, jobLess: false, maxInputs: 0, base: "", parts: null,
    ...extra,
  };
}

beforeEach(() => {
  resetInitialHandoffForTest();
  h.takeHandoff.mockReset().mockResolvedValue("");
  h.popOut.mockClear();
  h.relaySend.mockClear();
  h.relayListeners.clear();
  h.handlers.clear();
  setCurrentWindowForTest(null);
  useModules.getState().setAll([mod("stems", "Stem Splitter"), mod("editor", "Video Editor", { parts: ["stems"] })]);
  registerToolViews({ stems: FakeStems });
  useUI.setState({ view: "editor", handoff: null });
});

const link = { token: "tok1", host: "photo-composer", hostName: "Photo Composer", hostWindow: "main", useLabel: "Use as music" };

describe("ToolWindowShell embedded", () => {
  async function openWindow() {
    setCurrentWindowForTest(parseWindow("?window=tool&view=stems&key=tool:stems"));
    h.takeHandoff.mockResolvedValue(JSON.stringify({ moduleId: "stems", inputs: ["/song.mp3"], embed: link }));
    render(<ToolWindowShell view="stems" />);
    expect(await screen.findByText("stems view embedded:/song.mp3")).toBeTruthy();
  }

  it("provides the embed context, titles the window 'for <host>' and leaves the global handoff alone", async () => {
    await openWindow();
    expect(screen.getByText("for Photo Composer")).toBeTruthy();
    expect(useUI.getState().handoff).toBeNull();
  });

  it("Use relays the files to the host window and toasts once acked", async () => {
    await openWindow();
    await userEvent.click(screen.getByRole("button", { name: "Use as music" }));
    await waitFor(() => expect(h.relaySend).toHaveBeenCalled());
    expect(h.relaySend).toHaveBeenCalledWith("embed", { t: "use", token: "tok1", paths: ["/out/vocals.flac"] }, "main");
    act(() => h.relayListeners.forEach((cb) => cb({ channel: "embed", from: "main", to: "", payload: { t: "ack", token: "tok1" } })));
    expect(await screen.findByText("Sent to Photo Composer")).toBeTruthy();
  });

  it("toasts that the host is gone when nothing acks within a second", async () => {
    await openWindow();
    await userEvent.click(screen.getByRole("button", { name: "Use as music" }));
    expect(await screen.findByText("Photo Composer isn't open any more", {}, { timeout: 3000 })).toBeTruthy();
  });
});

function Reporter() {
  useCompositionInputs("editor", { stems: ["/song.mp3"] });
  return null;
}

describe("CompositionBar Uses chip", () => {
  function Fixture() {
    return (
      <ClickInHost>
        <Reporter />
        <CompositionBar view="editor" />
        <ConstituentDrawer view="editor" />
      </ClickInHost>
    );
  }

  it("opens the constituent in a drawer with the composition inputs", async () => {
    render(<Fixture />);
    await userEvent.click(screen.getByText("Stem Splitter"));
    expect(await screen.findByRole("dialog", { name: "Stem Splitter" })).toBeTruthy();
    expect(await screen.findByText("stems view embedded:/song.mp3")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use as music" })).toBeNull();
  });

  it("Shift+click opens its own window with the same inputs", async () => {
    render(<Fixture />);
    fireEvent.click(screen.getByText("Stem Splitter"), { shiftKey: true });
    await waitFor(() => expect(h.popOut).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
    const req = h.popOut.mock.calls[0]![0] as { key: string; handoff?: string };
    expect(req.key).toBe("tool:stems");
    expect(String(req.handoff)).toContain("/song.mp3");
  });

  it("the hover menu offers Open here, its own window and Go to", async () => {
    render(<Fixture />);
    await userEvent.click(screen.getByRole("button", { name: "Options for Stem Splitter" }));
    expect(await screen.findByRole("menuitem", { name: "Open here" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Open in its own window" })).toBeTruthy();
    await userEvent.click(screen.getByRole("menuitem", { name: "Go to Stem Splitter" }));
    expect(useUI.getState().view).toBe("stems");
  });
});
