import { render, screen } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/events", () => ({ on: () => () => undefined }));
vi.mock("@/tools", () => ({
  shellOverlays: [],
  toolViews: {
    paint: () => <div data-testid="paint-view">paint</div>,
    stems: () => <div data-testid="stems-view">stems</div>,
  },
  popupViews: {},
}));
vi.mock("@/viz/RenderHost", () => ({ default: () => null }));
vi.mock("@/views/LibraryView", () => ({ LibraryView: () => <div>library stub</div> }));

import type { Descriptor } from "@/lib/api";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { Shell } from "./Shell";

const mod = (id: string, name: string): Descriptor => ({ id, name, tagline: "", description: "", icon: "box", status: "ready", accepts: { extensions: [".png"], urls: false }, requires: null, recommends: null, base: "", parts: [], order: 1 }) as unknown as Descriptor;

beforeEach(() => {
  sessionStorage.clear();
  useModules.getState().setAll([mod("paint", "Paint+"), mod("stems", "Stem Splitter")]);
  useUI.setState({ view: "paint", handoff: null, drop: null, studio: false });
});

describe("Studio mode", () => {
  it("shows the sidebar and top bar normally", () => {
    render(<Shell />);
    expect(screen.getByTestId("paint-view")).toBeTruthy();
    expect(document.querySelector("nav, aside")).not.toBeNull();
    expect(screen.getByTestId("header-slot")).toBeTruthy();
    expect(document.getElementById("app-root")?.getAttribute("data-studio")).toBeNull();
  });

  it("hides the sidebar and top bar when the studio flag is on for Paint+", () => {
    render(<Shell />);
    act(() => useUI.getState().setStudio(true));
    expect(screen.getByTestId("paint-view")).toBeTruthy();
    expect(screen.queryByTestId("header-slot")).toBeNull();
    expect(document.querySelector("nav, aside")).toBeNull();
    expect(document.getElementById("app-root")?.getAttribute("data-studio")).toBe("true");
    expect(sessionStorage.getItem("toolbox.studio")).toBe("1");
  });

  it("only takes over for Paint+: other tools keep the chrome even with the flag set", () => {
    useUI.setState({ view: "stems" });
    render(<Shell />);
    act(() => useUI.getState().setStudio(true));
    expect(screen.getByTestId("stems-view")).toBeTruthy();
    expect(screen.getByTestId("header-slot")).toBeTruthy();
  });

  it("the chrome returns when the flag turns off, and the flag leaves with the session", () => {
    render(<Shell />);
    act(() => useUI.getState().setStudio(true));
    act(() => useUI.getState().setStudio(false));
    expect(screen.getByTestId("header-slot")).toBeTruthy();
    expect(sessionStorage.getItem("toolbox.studio")).toBeNull();
    expect(localStorage.getItem("toolbox.ui") ?? "").not.toMatch(/studio/);
  });
});
