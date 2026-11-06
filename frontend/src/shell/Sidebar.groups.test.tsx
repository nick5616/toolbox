import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { Category, ModuleStatus, type Descriptor } from "@/lib/api";
import { useDeps } from "@/state/deps";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { TOOL_MIME } from "@/lib/fileDrag";
import { Sidebar } from "./Sidebar";

function mod(id: string, name: string, category: Category, order: number): Descriptor {
  return {
    id, name, tagline: "", description: "", icon: "box", category, status: ModuleStatus.StatusReady,
    accepts: { extensions: null, urls: false, any: false }, requires: null, recommends: null, outputSubdir: "", order, hidden: false, jobLess: false, maxInputs: 0, base: "", parts: null,
  };
}

describe("Sidebar groups, pins and recents", () => {
  beforeEach(() => {
    useDeps.getState().setAll([]);
    useModules.getState().setAll([
      mod("stems", "Stems", Category.CategoryAudio, 1),
      mod("conv", "Converter", Category.CategoryMedia, 2),
      mod("bg", "Remover", Category.CategoryImage, 3),
    ]);
    useUI.setState({ view: "library", sidebarCollapsed: false, comingSoonOpen: false, pinned: [], recentTools: [], collapsedGroups: [] });
  });

  it("lists tools under category labels and Library/Pipelines apart", () => {
    render(<Sidebar />);
    for (const label of ["Video & media", "Audio", "Images", "Automation"]) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Library/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Pipelines/ })).toBeTruthy();
  });

  it("collapses a group and remembers it", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /Audio/ }));
    expect(screen.queryByRole("button", { name: /^Stems/ })).toBeNull();
    expect(useUI.getState().collapsedGroups).toEqual(["audio"]);
    fireEvent.click(screen.getByRole("button", { name: /Audio/ }));
    expect(screen.getByRole("button", { name: /^Stems/ })).toBeTruthy();
  });

  it("pins from the hover pin and from the context menu; Pinned group appears", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Converter" }));
    expect(useUI.getState().pinned).toEqual(["conv"]);
    expect(screen.getByText("Pinned")).toBeTruthy();
    fireEvent.contextMenu(screen.getAllByTestId("nav-stems")[0]!);
    fireEvent.click(screen.getByRole("menuitem", { name: /Pin to sidebar/ }));
    expect(useUI.getState().pinned).toEqual(["conv", "stems"]);
    fireEvent.contextMenu(screen.getAllByTestId("nav-stems")[0]!);
    fireEvent.click(screen.getByRole("menuitem", { name: /Unpin/ }));
    expect(useUI.getState().pinned).toEqual(["conv"]);
  });

  it("shows recently used tools after navigating", () => {
    render(<Sidebar />);
    expect(screen.queryByText("Recent tools")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Stems/ }));
    expect(useUI.getState().recentTools).toEqual(["stems"]);
    expect(screen.getByText("Recent tools")).toBeTruthy();
  });

  it("gives each tool the Mod+digit tooltip and makes it a drop target and tool drag source", () => {
    render(<Sidebar />);
    const row = screen.getByTestId("nav-conv");
    expect(row.id).toBe("tool-drop:conv");
    expect(row.hasAttribute("data-file-drop-target")).toBe(true);
    const btn = within(row).getByRole("button", { name: /^Converter/ });
    expect(btn.getAttribute("data-tip-kbd")).toBe("Mod+1");
    const data: Record<string, string> = {};
    fireEvent.dragStart(row, { dataTransfer: { setData: (k: string, v: string) => (data[k] = v), types: [] } });
    expect(data[TOOL_MIME]).toBe("conv");
  });

  it("the icon rail has separators between groups and no labels", () => {
    useUI.setState({ sidebarCollapsed: true });
    const { container } = render(<Sidebar />);
    expect(container.querySelectorAll("hr").length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText("Audio")).toBeNull();
  });
});
