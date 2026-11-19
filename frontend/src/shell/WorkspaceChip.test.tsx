import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({
  Switch: vi.fn(async () => undefined),
  Current: vi.fn(),
  List: vi.fn(),
  Presenter: vi.fn(),
}));
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, WorkspacesService: svc };
});

import { WorkspaceKind, type WorkspaceInfo } from "@/lib/api";
import { useUI } from "@/state/ui";
import { useWorkspace } from "@/state/workspace";
import { WorkspaceChip } from "./WorkspaceChip";
import { workspaceCommands } from "./useBuiltinCommands";

export function info(over: Partial<WorkspaceInfo>): WorkspaceInfo {
  return {
    id: "personal", name: "Personal", kind: WorkspaceKind.KindPersonal, root: "", baseline: "", present: false,
    keep: [], exclude: [], stripLocation: false, created: 0, current: false, missing: false, ...over,
  };
}

const personal = info({ current: true });
const demo = info({ id: "abc123abc123", name: "Demo", kind: WorkspaceKind.KindDemo, root: "D:\\ws\\demo" });
const gone = info({ id: "def456def456", name: "USB", kind: WorkspaceKind.KindStandard, root: "E:\\usb", missing: true });

describe("WorkspaceChip", () => {
  beforeEach(() => {
    svc.Switch.mockClear();
    useWorkspace.setState({ current: personal, list: [personal, demo, gone], switchRequest: null, newRequested: false });
    useUI.setState({ view: "library" });
  });

  it("shows nothing until a workspace is loaded", () => {
    useWorkspace.setState({ current: null, list: [] });
    const { container } = render(<WorkspaceChip collapsed={false} />);
    expect(container.textContent).toBe("");
  });

  it("Personal has a name and no dot; Demo has a dot; the sandbox has a badge", () => {
    const { rerender } = render(<WorkspaceChip collapsed={false} />);
    expect(screen.getByTestId("workspace-chip").textContent).toContain("Personal");
    expect(screen.queryByTestId("workspace-dot")).toBeNull();
    act(() => useWorkspace.setState({ current: { ...demo, current: true } }));
    rerender(<WorkspaceChip collapsed={false} />);
    expect(screen.getByTestId("workspace-dot")).toBeTruthy();
    act(() => useWorkspace.setState({ current: info({ id: "sandbox", name: "Dev sandbox", kind: WorkspaceKind.KindSandbox, current: true }) }));
    expect(screen.getByTestId("workspace-chip").textContent).toContain("sandbox");
    expect(screen.queryByTestId("workspace-dot")).toBeNull();
  });

  it("collapsed shows only the icon, with a name for assistive tech and a tooltip", () => {
    render(<WorkspaceChip collapsed />);
    const chip = screen.getByTestId("workspace-chip");
    expect(chip.textContent).toBe("");
    expect(chip.getAttribute("aria-label")).toBe("Workspace: Personal");
    expect(chip.getAttribute("data-tip")).toContain("Personal");
  });

  it("the menu checks the current workspace and disables a missing one with a reason", () => {
    render(<WorkspaceChip collapsed={false} />);
    fireEvent.click(screen.getByTestId("workspace-chip"));
    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    const usb = screen.getByRole("menuitemradio", { name: /USB/ });
    expect(usb.getAttribute("aria-disabled")).toBe("true");
    expect(usb.getAttribute("data-tip")).toMatch(/folder isn't there/);
    expect(usb.textContent).toContain("Missing");
    fireEvent.click(usb);
    expect(svc.Switch).not.toHaveBeenCalled();
    expect(screen.getByRole("menuitem", { name: /New workspace/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Manage workspaces/ })).toBeTruthy();
  });

  it("choosing another workspace switches to it", () => {
    render(<WorkspaceChip collapsed={false} />);
    fireEvent.click(screen.getByTestId("workspace-chip"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Demo/ }));
    expect(svc.Switch).toHaveBeenCalledWith("abc123abc123");
  });

  it("Manage workspaces opens Settings; New workspace asks Settings for the dialog", () => {
    render(<WorkspaceChip collapsed={false} />);
    fireEvent.click(screen.getByTestId("workspace-chip"));
    fireEvent.click(screen.getByRole("menuitem", { name: /New workspace/ }));
    expect(useUI.getState().view).toBe("settings");
    expect(useWorkspace.getState().newRequested).toBe(true);
  });

  it("shows a boot notice once", () => {
    render(<WorkspaceChip collapsed={false} />);
    act(() => useWorkspace.setState({ notice: "Demo's folder isn't there" }));
    expect(useWorkspace.getState().notice).toBe("");
  });

  it("a switch request from a second launch asks first", () => {
    render(<WorkspaceChip collapsed={false} />);
    act(() => useWorkspace.getState().requestSwitch({ id: "abc123abc123", name: "Demo" }));
    expect(screen.getByText("Switch to Demo?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    expect(svc.Switch).toHaveBeenCalledWith("abc123abc123");
    expect(useWorkspace.getState().switchRequest).toBeNull();
  });
});

describe("workspaceCommands", () => {
  it("offers the manager, New and the other reachable workspaces", () => {
    const ids = workspaceCommands([personal, demo, gone]).map((c) => c.id);
    expect(ids).toEqual(["workspace.switch", "workspace.new", "workspace.switch.abc123abc123"]);
  });
});
