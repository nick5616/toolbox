import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  takeHandoff: vi.fn<(key: string) => Promise<string>>(() => Promise.resolve("")),
}));

vi.mock("@/lib/api", async (orig) => {
  const real = await orig<typeof import("@/lib/api")>();
  return { ...real, DesktopService: { ...real.DesktopService, TakeHandoff: h.takeHandoff, ShowMain: vi.fn(() => Promise.resolve()), CloseWindow: vi.fn(() => Promise.resolve()) } };
});
vi.mock("@/lib/events", () => ({ on: () => () => undefined }));
vi.mock("@/tools", () => ({
  shellOverlays: [],
  toolViews: {
    stems: () => (
      <div data-testid="view">
        <ToolHeader aria-label="Stems header">
          <button type="button">Save it</button>
        </ToolHeader>
        <p>view body</p>
      </div>
    ),
  },
  popupViews: {},
}));
vi.mock("@/viz/RenderHost", () => ({ default: () => null }));
vi.mock("@/views/LibraryView", () => ({ LibraryView: () => <div>library stub</div> }));

import type { Descriptor } from "@/lib/api";
import { ToolHeader } from "@/components";
import { HeaderPresenceContext, HeaderSlotProvider } from "@/components/ToolHeader";
import { EmbedContext, type EmbedContextValue } from "@/lib/embed";
import { parseWindow, setCurrentWindowForTest } from "@/lib/windows";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { Shell } from "./Shell";
import { ToolWindowShell, resetInitialHandoffForTest } from "./ToolWindowShell";

function mod(id: string, name: string, parts: string[] = []): Descriptor {
  return { id, name, tagline: "", description: "", icon: "box", status: "ready", accepts: { extensions: [".mp3"], urls: false }, requires: null, recommends: null, base: "", parts, order: 1 } as unknown as Descriptor;
}

beforeEach(() => {
  resetInitialHandoffForTest();
  h.takeHandoff.mockReset().mockResolvedValue("");
  useModules.getState().setAll([mod("stems", "Stem Splitter", ["other"]), mod("other", "Other Tool")]);
  useUI.setState({ view: "stems", handoff: null, drop: null });
  setCurrentWindowForTest(null);
});

describe("ToolHeader", () => {
  it("renders inline without a slot", () => {
    render(
      <div data-testid="host">
        <ToolHeader aria-label="H">
          <span>inline header</span>
        </ToolHeader>
      </div>,
    );
    expect(within(screen.getByTestId("host")).getByRole("toolbar", { name: "H" })).toBeTruthy();
  });

  it("portals into the slot when one is provided", () => {
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    render(
      <div data-testid="host">
        <HeaderSlotProvider value={slot}>
          <ToolHeader aria-label="H">
            <span>portaled</span>
          </ToolHeader>
        </HeaderSlotProvider>
      </div>,
    );
    expect(within(slot).getByText("portaled")).toBeTruthy();
    expect(within(screen.getByTestId("host")).queryByText("portaled")).toBeNull();
    slot.remove();
  });

  it("renders inline when embedded, even with a slot", () => {
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    const embed = { host: "x", hostName: "X", placement: "drawer", handoff: null } as unknown as EmbedContextValue;
    render(
      <div data-testid="host">
        <EmbedContext.Provider value={embed}>
          <HeaderSlotProvider value={slot}>
            <ToolHeader>
              <span>embedded header</span>
            </ToolHeader>
          </HeaderSlotProvider>
        </EmbedContext.Provider>
      </div>,
    );
    expect(within(screen.getByTestId("host")).getByText("embedded header")).toBeTruthy();
    expect(slot.textContent).toBe("");
    slot.remove();
  });

  it("reports its presence while portaled", () => {
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    const report = vi.fn();
    const { unmount } = render(
      <HeaderPresenceContext.Provider value={report}>
        <HeaderSlotProvider value={slot}>
          <ToolHeader>x</ToolHeader>
        </HeaderSlotProvider>
      </HeaderPresenceContext.Provider>,
    );
    expect(report).toHaveBeenLastCalledWith(true);
    unmount();
    expect(report).toHaveBeenLastCalledWith(false);
    slot.remove();
  });
});

describe("shell header slots", () => {
  it("the main window's top bar holds the tool header, and the chips condense", async () => {
    render(<Shell />);
    const slot = await screen.findByTestId("header-slot");
    expect(within(slot).getByRole("button", { name: "Save it" })).toBeTruthy();
    // Not under the view: one header row.
    expect(within(screen.getByTestId("view")).queryByRole("button", { name: "Save it" })).toBeNull();
    const bar = await screen.findByTestId("composition-bar");
    expect(bar.getAttribute("data-condensed")).toBe("true");
    expect(within(bar).getByRole("button", { name: "Uses" })).toBeTruthy();
  });

  it("a tool without a header keeps the full chips", () => {
    useUI.setState({ view: "library" });
    render(<Shell />);
    expect(screen.queryByTestId("composition-bar")).toBeNull();
  });

  it("a tool window's title bar holds the tool header", async () => {
    setCurrentWindowForTest(parseWindow("?window=tool&view=stems&key=tool:stems"));
    render(<ToolWindowShell view="stems" />);
    const slot = await screen.findByTestId("header-slot");
    expect(await within(slot).findByRole("button", { name: "Save it" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bring back" })).toBeTruthy();
  });
});
