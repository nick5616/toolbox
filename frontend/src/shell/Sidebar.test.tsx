import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { Category, DepSource, DepState, ModuleStatus, type DepStatus, type Descriptor } from "@/lib/api";
import { useDeps } from "@/state/deps";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { Sidebar } from "./Sidebar";

function mod(id: string, name: string, status: ModuleStatus, order: number): Descriptor {
  return {
    id, name, tagline: "", description: "", icon: "box", category: Category.$zero, status,
    accepts: { extensions: null, urls: false }, requires: null, recommends: null, outputSubdir: "", order, hidden: false, jobLess: false, maxInputs: 0,
  };
}

function dep(id: string, state: DepState, required: boolean): DepStatus {
  return {
    id, name: id, purpose: "", state, version: "", path: "", source: DepSource.$zero, managed: false,
    required, requiredBy: null, recommendedBy: null, installHint: "", error: "", checkedAt: 0,
  };
}

describe("Sidebar", () => {
  beforeEach(() => {
    useModules.getState().setAll([
      mod("downloader", "Downloader", ModuleStatus.StatusReady, 1),
      mod("stems", "Stems", ModuleStatus.StatusComingSoon, 2),
    ]);
    useDeps.getState().setAll([]);
    useUI.setState({ view: "library", sidebarCollapsed: false, comingSoonOpen: false });
  });

  it("renders ready tools and a collapsed coming-soon section", () => {
    render(<Sidebar />);
    expect(screen.getByRole("button", { name: /Recent/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Downloader/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Stems/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Coming soon/i }));
    const stems = screen.getByRole("button", { name: /Stems/ });
    expect(stems.textContent).toContain("SOON");
  });

  it("navigates on click, including coming-soon items", () => {
    useUI.setState({ comingSoonOpen: true });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /Downloader/ }));
    expect(useUI.getState().view).toBe("downloader");
    fireEvent.click(screen.getByRole("button", { name: /Stems/ }));
    expect(useUI.getState().view).toBe("stems");
    fireEvent.click(screen.getByRole("button", { name: /Settings/ }));
    expect(useUI.getState().view).toBe("settings");
  });

  it("marks the active item", () => {
    render(<Sidebar />);
    expect(screen.getByRole("button", { name: /Recent/ }).getAttribute("aria-current")).toBe("page");
  });

  it("shows an amber dot on Settings when a required dep is missing", () => {
    useDeps.getState().setAll([dep("yt-dlp", DepState.DepMissing, true)]);
    render(<Sidebar />);
    expect(screen.getByTestId("dot-warn")).toBeTruthy();
    expect(screen.queryByTestId("dot-danger")).toBeNull();
  });

  it("shows a red dot when a required dep errors, none for optional deps", () => {
    useDeps.getState().setAll([dep("ffmpeg", DepState.DepError, true)]);
    const { unmount } = render(<Sidebar />);
    expect(screen.getByTestId("dot-danger")).toBeTruthy();
    unmount();
    useDeps.getState().setAll([dep("deno", DepState.DepMissing, false)]);
    render(<Sidebar />);
    expect(screen.queryByTestId("dot-warn")).toBeNull();
  });
});
