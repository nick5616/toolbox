import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({
  Create: vi.fn(),
  AddExisting: vi.fn(),
  Rename: vi.fn(async () => undefined),
  Remove: vi.fn(async () => undefined),
  Switch: vi.fn(async () => undefined),
  SetPresent: vi.fn(async () => undefined),
  Restore: vi.fn(),
  TidyPreview: vi.fn(),
  Tidy: vi.fn(),
  Current: vi.fn(),
  List: vi.fn(async () => []),
  Presenter: vi.fn(),
}));
const settingsSvc = vi.hoisted(() => ({ ModuleState: vi.fn(async () => ""), SetModuleState: vi.fn(async () => undefined) }));
const filesSvc = vi.hoisted(() => ({ PickFolder: vi.fn(async () => "") }));
vi.mock("@/lib/events", () => ({ on: () => () => undefined }));
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, WorkspacesService: svc, SettingsService: settingsSvc, FilesService: filesSvc, LibraryService: { RevealPath: vi.fn(async () => undefined) } };
});

import { WorkspaceKind, type WorkspaceInfo } from "@/lib/api";
import { defaultSettings, useSettings } from "@/state/settings";
import { useWorkspace } from "@/state/workspace";
import { SettingsWorkspaces, defaultFolder, folderNameFor, joinPath, validateNewWorkspace } from "./SettingsWorkspaces";

function info(over: Partial<WorkspaceInfo>): WorkspaceInfo {
  return {
    id: "personal", name: "Personal", kind: WorkspaceKind.KindPersonal, root: "", baseline: "", present: false,
    keep: [], exclude: [], stripLocation: false, created: 0, current: false, missing: false, ...over,
  };
}

const personal = info({});
const demo = info({ id: "abc123abc123", name: "Demo", kind: WorkspaceKind.KindDemo, root: "D:\\ws\\demo", baseline: "D:\\demoAssets" });
const gone = info({ id: "def456def456", name: "USB", kind: WorkspaceKind.KindStandard, root: "E:\\usb", missing: true });

function setState(current: WorkspaceInfo, all: WorkspaceInfo[]) {
  useWorkspace.setState({
    loaded: true,
    current: { ...current, current: true },
    list: all.map((w) => ({ ...w, current: w.id === current.id })),
    presenter: { on: false, root: current.root, name: current.name, home: "C:\\Users\\nick" },
    newRequested: false,
  });
}

describe("helpers", () => {
  it("joins with the parent's separator", () => {
    expect(joinPath("C:\\Users\\nick\\Toolbox Workspaces", "Demo")).toBe("C:\\Users\\nick\\Toolbox Workspaces\\Demo");
    expect(joinPath("/Users/nick/ws/", "Demo")).toBe("/Users/nick/ws/Demo");
  });
  it("makes a safe folder name", () => {
    expect(folderNameFor(" My: demo/1? ")).toBe("My- demo-1-");
    expect(defaultFolder("/p", "")).toBe("");
    expect(defaultFolder("/p", "Demo")).toBe("/p/Demo");
  });
  it("validates name and folder", () => {
    expect(validateNewWorkspace({ name: "", folder: "C:\\a", baseline: "" }).name).toBeTruthy();
    expect(validateNewWorkspace({ name: "x".repeat(41), folder: "C:\\a", baseline: "" }).name).toMatch(/40/);
    expect(validateNewWorkspace({ name: "Demo", folder: "", baseline: "" }).folder).toBeTruthy();
    expect(validateNewWorkspace({ name: "Demo", folder: "relative/dir", baseline: "" }).folder).toBeTruthy();
    expect(validateNewWorkspace({ name: "Demo", folder: "/abs/dir", baseline: "" })).toEqual({});
    expect(validateNewWorkspace({ name: "Demo", folder: "C:\\abs", baseline: "" })).toEqual({});
  });
});

describe("SettingsWorkspaces", () => {
  beforeEach(() => {
    for (const f of Object.values(svc)) f.mockClear();
    svc.List.mockResolvedValue([]);
    svc.Current.mockResolvedValue(personal);
    svc.Presenter.mockResolvedValue({ on: false, root: "", name: "", home: "C:\\Users\\nick" });
    settingsSvc.ModuleState.mockResolvedValue("");
    useSettings.setState({ settings: { ...defaultSettings(), libraryDir: "C:\\Users\\nick\\Toolbox" } });
    setState(personal, [personal, demo, gone]);
  });

  it("Personal can't be renamed or removed, and says why", () => {
    render(<SettingsWorkspaces />);
    const row = within(screen.getByTestId("workspace-row-personal"));
    const rename = row.getByRole("button", { name: "Rename" });
    const remove = row.getByRole("button", { name: "Remove from list" });
    expect(rename.getAttribute("aria-disabled")).toBe("true");
    expect(rename.getAttribute("data-tip")).toMatch(/Personal/);
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(remove.getAttribute("data-tip")).toMatch(/Personal/);
  });

  it("a missing workspace can't be switched to; another one can", async () => {
    const user = userEvent.setup();
    render(<SettingsWorkspaces />);
    const usb = within(screen.getByTestId("workspace-row-def456def456"));
    expect(usb.getByRole("button", { name: "Switch" }).getAttribute("aria-disabled")).toBe("true");
    expect(usb.getByText("Missing")).toBeTruthy();
    await user.click(within(screen.getByTestId("workspace-row-abc123abc123")).getByRole("button", { name: "Switch" }));
    expect(svc.Switch).toHaveBeenCalledWith("abc123abc123");
  });

  it("removing says the files stay, then removes only the list entry", async () => {
    const user = userEvent.setup();
    render(<SettingsWorkspaces />);
    await user.click(within(screen.getByTestId("workspace-row-def456def456")).getByRole("button", { name: "Remove from list" }));
    expect(screen.getByText(/every file in it stay where they are/)).toBeTruthy();
    await user.click(screen.getAllByRole("button", { name: "Remove from list" }).at(-1)!);
    await waitFor(() => expect(svc.Remove).toHaveBeenCalledWith("def456def456"));
  });

  it("Personal has no tidy or restore", () => {
    render(<SettingsWorkspaces />);
    expect(screen.getByRole("button", { name: "Restore baseline" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: /Tidy up after a demo/ }).getAttribute("aria-disabled")).toBe("true");
  });

  it("Tidy shows a preview with the count, size and sample", async () => {
    setState(demo, [personal, demo]);
    svc.TidyPreview.mockResolvedValue({ files: 3, bytes: 2048, sample: ["Demo/Library/Stems/a.flac"], jobs: 0 });
    const user = userEvent.setup();
    render(<SettingsWorkspaces />);
    await user.click(screen.getByRole("button", { name: /Tidy up after a demo/ }));
    expect(await screen.findByText(/3 files, 2\.0 KiB/)).toBeTruthy();
    expect(screen.getByRole("dialog").querySelector('[title="Demo/Library/Stems/a.flac"]')).not.toBeNull();
    svc.Tidy.mockResolvedValue({ id: "j1" });
    const confirm = screen.getByRole("button", { name: "Move to trash" });
    expect(confirm.getAttribute("aria-disabled")).toBeNull();
  });

  it("Tidy is blocked while jobs run", async () => {
    setState(demo, [personal, demo]);
    svc.TidyPreview.mockResolvedValue({ files: 3, bytes: 100, sample: [], jobs: 2 });
    const user = userEvent.setup();
    render(<SettingsWorkspaces />);
    await user.click(screen.getByRole("button", { name: /Tidy up after a demo/ }));
    expect(await screen.findByText("Wait for 2 jobs to finish")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move to trash" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("the Hide personal details toggle calls SetPresent", async () => {
    setState(demo, [personal, demo]);
    const user = userEvent.setup();
    render(<SettingsWorkspaces />);
    await user.click(screen.getByRole("switch", { name: "Hide personal details" }));
    expect(svc.SetPresent).toHaveBeenCalledWith(true);
  });

  it("New workspace: default folder follows the name, validation blocks an empty name", async () => {
    const user = userEvent.setup();
    useWorkspace.setState({ presenter: { on: false, root: "", name: "", home: "C:\\Users\\nick" } });
    render(<SettingsWorkspaces />);
    await user.click(screen.getByRole("button", { name: /^New…/ }));
    const dialog = within(screen.getByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Create and open" }));
    expect(svc.Create).not.toHaveBeenCalled();
    expect(await dialog.findByText("Give the workspace a name")).toBeTruthy();
    await user.type(dialog.getByLabelText("Name"), "Demo");
    expect((dialog.getByLabelText("Folder") as HTMLInputElement).value).toBe("C:\\Users\\nick\\Toolbox Workspaces\\Demo");
  });

  it("New workspace remembers the parent and creates", async () => {
    settingsSvc.ModuleState.mockResolvedValue(JSON.stringify({ parent: "D:\\Work" }));
    svc.Create.mockResolvedValue(info({ id: "n1n1n1n1n1n1", name: "Talk", root: "D:\\Work\\Talk" }));
    const user = userEvent.setup();
    render(<SettingsWorkspaces />);
    await user.click(screen.getByRole("button", { name: /^New…/ }));
    const dialog = within(screen.getByRole("dialog"));
    await user.type(dialog.getByLabelText("Name"), "Talk");
    await waitFor(() => expect((dialog.getByLabelText("Folder") as HTMLInputElement).value).toBe("D:\\Work\\Talk"));
    await user.click(dialog.getByRole("button", { name: "Create and open" }));
    await waitFor(() =>
      expect(svc.Create).toHaveBeenCalledWith({ name: "Talk", root: "D:\\Work\\Talk", kind: WorkspaceKind.KindStandard, baseline: "", present: false }),
    );
    await waitFor(() => expect(svc.Switch).toHaveBeenCalledWith("n1n1n1n1n1n1"));
    expect(settingsSvc.SetModuleState).toHaveBeenCalledWith("workspaces", JSON.stringify({ parent: "D:\\Work" }));
  });

  it("choosing Demo turns Hide personal details on", async () => {
    const user = userEvent.setup();
    render(<SettingsWorkspaces />);
    await user.click(screen.getByRole("button", { name: /^New…/ }));
    const dialog = within(screen.getByRole("dialog"));
    const hide = dialog.getByRole("switch", { name: "Hide personal details" });
    expect(hide.getAttribute("aria-checked")).toBe("false");
    await user.selectOptions(dialog.getByLabelText("Kind"), WorkspaceKind.KindDemo);
    expect(hide.getAttribute("aria-checked")).toBe("true");
  });

  it("opens the New dialog when the chip or palette asked for it", async () => {
    render(<SettingsWorkspaces />);
    useWorkspace.getState().setNewRequested(true);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(useWorkspace.getState().newRequested).toBe(false);
  });

  it("shows folders through displayPath when Hide personal details is on", () => {
    useWorkspace.setState({ presenter: { on: true, root: "D:\\ws\\demo", name: "Demo", home: "C:\\Users\\nick" } });
    render(<SettingsWorkspaces />);
    expect(screen.getByTestId("workspace-row-abc123abc123").querySelector('[title="Demo"]')).not.toBeNull();
    expect(screen.getByTestId("workspace-row-personal").querySelector('[title="~/Toolbox"]')).not.toBeNull();
  });
});
