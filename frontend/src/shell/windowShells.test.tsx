import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "zustand/vanilla";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Descriptor } from "@/lib/api";
import { definePart } from "@/parts/registry";
import { PartFrame } from "@/parts/PartFrame";
import { replicaBridge, resetBridgeStatusesForTest, type BridgeTransport } from "@/state/bridge";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { useWindows } from "@/state/windows";
import { parseWindow, setCurrentWindowForTest } from "@/lib/windows";

const h = vi.hoisted(() => ({
  takeHandoff: vi.fn<(key: string) => Promise<string>>(() => Promise.resolve("")),
  showMain: vi.fn(() => Promise.resolve()),
  closeWindow: vi.fn(() => Promise.resolve()),
  focusWindow: vi.fn(() => Promise.resolve()),
  popOut: vi.fn(() => Promise.resolve()),
  handlers: new Map<string, (d: unknown) => void>(),
}));

vi.mock("@/lib/api", async (orig) => {
  const real = await orig<typeof import("@/lib/api")>();
  return {
    ...real,
    DesktopService: {
      ...real.DesktopService,
      TakeHandoff: h.takeHandoff,
      ShowMain: h.showMain,
      CloseWindow: h.closeWindow,
      FocusWindow: h.focusWindow,
      PopOut: h.popOut,
    },
  };
});
vi.mock("@/lib/events", () => ({
  on: (name: string, cb: (d: unknown) => void) => {
    h.handlers.set(name, cb);
    return () => h.handlers.delete(name);
  },
}));
vi.mock("@/tools", () => ({
  toolViews: {
    stems: () => {
      const handoff = useUI((s) => s.handoff);
      return <div>stems view {handoff ? (handoff.inputs ?? []).join(",") : "none"}</div>;
    },
  },
  popupViews: {},
}));
vi.mock("@/viz/RenderHost", () => ({ default: () => null }));
vi.mock("@/views/LibraryView", () => ({ LibraryView: () => <div>library stub</div> }));

import { PartWindowShell } from "./PartWindowShell";
import { PoppedOutPlaceholder } from "./PoppedOutPlaceholder";
import { Shell } from "./Shell";
import { ToolWindowShell } from "./ToolWindowShell";

function mod(id: string, name: string, base = ""): Descriptor {
  return { id, name, tagline: "", description: "", icon: "box", status: "ready", accepts: { extensions: [".mp3"], urls: false }, requires: null, recommends: null, base, parts: [], order: 1 } as unknown as Descriptor;
}

beforeEach(() => {
  h.takeHandoff.mockReset().mockResolvedValue("");
  h.showMain.mockClear();
  h.closeWindow.mockClear();
  h.focusWindow.mockClear();
  h.popOut.mockClear();
  h.handlers.clear();
  useModules.getState().setAll([mod("stems", "Stem Splitter")]);
  useWindows.setState({ open: [] });
  useUI.setState({ view: "stems", handoff: null, drop: null });
  resetBridgeStatusesForTest();
  setCurrentWindowForTest(null);
});

describe("ToolWindowShell", () => {
  it("renders the tool with a top bar and takes its handoff before mounting it", async () => {
    setCurrentWindowForTest(parseWindow("?window=tool&view=stems&key=tool:stems"));
    h.takeHandoff.mockResolvedValue(JSON.stringify({ moduleId: "stems", inputs: ["/a.mp3"] }));
    render(<ToolWindowShell view="stems" />);
    expect(screen.getByRole("heading", { name: "Stem Splitter" })).toBeTruthy();
    expect(await screen.findByText("stems view /a.mp3")).toBeTruthy();
    expect(h.takeHandoff).toHaveBeenCalledWith("tool:stems");
  });

  it("hands off again on windows:handoff for its key only", async () => {
    setCurrentWindowForTest(parseWindow("?window=tool&view=stems&key=tool:stems"));
    render(<ToolWindowShell view="stems" />);
    await screen.findByText("stems view none");
    h.takeHandoff.mockResolvedValue(JSON.stringify({ moduleId: "stems", inputs: ["/b.mp3"] }));
    await act(async () => h.handlers.get("windows:handoff")?.({ key: "tool:other" }));
    expect(h.takeHandoff).toHaveBeenCalledTimes(1);
    await act(async () => h.handlers.get("windows:handoff")?.({ key: "tool:stems" }));
    expect(await screen.findByText("stems view /b.mp3")).toBeTruthy();
  });

  it("Bring back shows main on the tool, then closes its own window", async () => {
    setCurrentWindowForTest(parseWindow("?window=tool&view=stems&key=tool:stems"));
    const user = userEvent.setup();
    render(<ToolWindowShell view="stems" />);
    await user.click(screen.getByRole("button", { name: "Bring back" }));
    await waitFor(() => expect(h.closeWindow).toHaveBeenCalledWith("tool:stems"));
    expect(h.showMain).toHaveBeenCalledWith("stems");
  });
});

describe("main window pop out", () => {
  it("shows a Pop out button on tool views that opens the tool's window", async () => {
    const user = userEvent.setup();
    render(<Shell />);
    await user.click(screen.getByRole("button", { name: "Pop out" }));
    await waitFor(() => expect(h.popOut).toHaveBeenCalled());
    const req = (h.popOut.mock.calls[0] as unknown as [{ key: string; query: string; title: string }])[0];
    expect(req.key).toBe("tool:stems");
    expect(req.query).toBe("window=tool&view=stems");
    expect(req.title).toBe("Stem Splitter — Toolbox");
  });

  it("has no Pop out on the library", () => {
    useUI.setState({ view: "library" });
    render(<Shell />);
    expect(screen.queryByRole("button", { name: "Pop out" })).toBeNull();
  });

  it("swaps the tool for a placeholder while its window is open, and Bring back closes it", async () => {
    useWindows.setState({ open: ["tool:stems"] });
    const user = userEvent.setup();
    render(<Shell />);
    expect(screen.getByText("Stem Splitter is open in its own window")).toBeTruthy();
    expect(screen.queryByText(/stems view/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show window" }));
    expect(h.focusWindow).toHaveBeenCalledWith("tool:stems");
    await user.click(screen.getByRole("button", { name: "Bring back" }));
    expect(h.closeWindow).toHaveBeenCalledWith("tool:stems");
    act(() => useWindows.getState().setOpen([]));
    expect(await screen.findByText("stems view none")).toBeTruthy();
  });

  it("placeholder names the family member that is out", () => {
    useModules.getState().setAll([mod("video-studio", "Video Editor"), mod("edit-studio", "Edit Studio", "video-studio")]);
    render(<PoppedOutPlaceholder windowKey="tool:edit-studio" />);
    expect(screen.getByText("Edit Studio is open in its own window")).toBeTruthy();
  });
});

describe("PartFrame", () => {
  beforeEach(() => {
    definePart({ id: "t.view", host: "stems", title: "Viewer", icon: "eye", tip: "The viewer", width: 640, height: 480, component: () => null });
  });

  it("pops the part out with its params and the current view, and shows a placeholder while out", async () => {
    const user = userEvent.setup();
    render(
      <PartFrame part="t.view" instance="1" params={{ project: "p" }} chrome="header">
        <div>inline content</div>
      </PartFrame>,
    );
    expect(screen.getByText("inline content")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Pop out" }));
    const req = (h.popOut.mock.calls[0] as unknown as [{ key: string; query: string; width: number }])[0];
    expect(req.key).toBe("part:t.view@1");
    expect(new URLSearchParams(req.query).get("project")).toBe("p");
    expect(new URLSearchParams(req.query).get("view")).toBe("stems");
    expect(req.width).toBe(640);

    act(() => useWindows.getState().setOpen(["part:t.view@1"]));
    expect(screen.queryByText("inline content")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Bring back" }));
    expect(h.closeWindow).toHaveBeenCalledWith("part:t.view@1");
  });
});

describe("PartWindowShell", () => {
  const spec = (connect?: (p: URLSearchParams) => Promise<() => void>) =>
    definePart({ id: "t.panel", host: "stems", title: "Panel", icon: "eye", tip: "", width: 1, height: 1, component: () => <div>panel body</div>, connect });

  it("explains an unknown part", () => {
    setCurrentWindowForTest(parseWindow("?window=part&part=nope&key=part:nope"));
    render(<PartWindowShell part="nope" />);
    expect(screen.getByText("Nothing to show here")).toBeTruthy();
  });

  it("connects, then renders the part in window placement", async () => {
    setCurrentWindowForTest(parseWindow("?window=part&part=t.panel&key=part:t.panel&project=p9"));
    const connect = vi.fn(() => Promise.resolve(() => undefined));
    spec(connect);
    render(<PartWindowShell part="t.panel" />);
    expect(await screen.findByText("panel body")).toBeTruthy();
    expect((connect.mock.calls[0] as unknown as [URLSearchParams])[0].get("project")).toBe("p9");
  });

  it("waits for the host, then says to open it in the main window", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setCurrentWindowForTest(parseWindow("?window=part&part=t.panel&key=part:t.panel"));
      const transport: BridgeTransport = { send: () => undefined, on: () => () => undefined };
      const store = createStore<{ n: number }>(() => ({ n: 0 }));
      spec(() => {
        const off = replicaBridge(store, { name: "t", pick: (s) => s, apply: (st, v) => st.setState(v), actions: [] }, { transport });
        return Promise.resolve(off);
      });
      render(<PartWindowShell part="t.panel" />);
      expect(await screen.findByText("Connecting…")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6100);
      });
      expect(screen.getByText("Open Stem Splitter in the main window first")).toBeTruthy();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(screen.getByRole("button", { name: "Show main window" }));
      expect(h.focusWindow).toHaveBeenCalledWith("main");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops rendering when the host goes away", async () => {
    setCurrentWindowForTest(parseWindow("?window=part&part=t.panel&key=part:t.panel"));
    let deliver: (p: unknown) => void = () => undefined;
    const transport: BridgeTransport = {
      send: () => undefined,
      on: (cb) => {
        deliver = (p) => cb(p, "main");
        return () => undefined;
      },
    };
    const store = createStore<{ n: number }>(() => ({ n: 0 }));
    spec(() => {
      const off = replicaBridge(store, { name: "t2", pick: (s) => s, apply: (st, v) => st.setState(v), actions: [] }, { transport });
      return Promise.resolve(off);
    });
    render(<PartWindowShell part="t.panel" />);
    await screen.findByText("Connecting…");
    act(() => deliver({ t: "snap", seq: 0, values: { n: 1 } }));
    expect(await screen.findByText("panel body")).toBeTruthy();
    act(() => deliver({ t: "bye" }));
    expect(await screen.findByText(/window closed this panel's project/)).toBeTruthy();
    expect(screen.queryByText("panel body")).toBeNull();
  });
});
