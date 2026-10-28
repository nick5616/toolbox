import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const updateExiftool = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    LibraryService: { OpenLibraryFolder: vi.fn(), RevealPath: vi.fn() },
    SettingsService: { ChooseLibraryDir: vi.fn() },
    DepsService: { ...actual.DepsService, UpdateExiftool: (...a: unknown[]) => updateExiftool(...a) },
  };
});

import { DepSource, DepState, type DepStatus, type Settings, type SettingsPatch } from "@/lib/api";
import { useDeps } from "@/state/deps";
import { useDesktop } from "@/state/desktop";
import { DEFAULT_HOTKEYS, defaultSettings, useSettings } from "@/state/settings";
import { SettingsView } from "./SettingsView";

function exifDep(state: DepState): DepStatus {
  return {
    id: "exiftool",
    name: "ExifTool",
    purpose: "p",
    state,
    version: "",
    path: "",
    source: DepSource.SourcePath,
    required: true,
    requiredBy: ["exif"],
    recommendedBy: null,
    installHint: "",
    error: "",
  } as DepStatus;
}

describe("Settings → General / Clipboard / ExifTool", () => {
  let update: Mock<(p: Partial<SettingsPatch>) => Promise<Settings>>;

  beforeEach(() => {
    update = vi.fn<(p: Partial<SettingsPatch>) => Promise<Settings>>().mockResolvedValue({} as Settings);
    useSettings.setState({ update, settings: { ...defaultSettings(), libraryDir: "/lib" }, appInfo: null });
    useDesktop.setState({ hotkeys: [] });
    useDeps.getState().setAll([exifDep(DepState.DepMissing)]);
    updateExiftool.mockReset();
  });

  it("switches send the right patches", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("switch", { name: /Keep Toolbox running in the tray/ }));
    expect(update).toHaveBeenCalledWith({ keepInTray: false });
    fireEvent.click(screen.getByRole("switch", { name: "Start Toolbox at login" }));
    expect(update).toHaveBeenCalledWith({ startAtLogin: true });
    fireEvent.click(screen.getByRole("switch", { name: "Enable clipboard history" }));
    expect(update).toHaveBeenCalledWith({ clipboard: { ...defaultSettings().clipboard, enabled: true } });
  });

  it("shows the login error inline", async () => {
    update.mockRejectedValue({ cause: JSON.stringify({ code: "validation", message: "bad", fields: { startAtLogin: "Not permitted by the OS" } }) });
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("switch", { name: "Start Toolbox at login" }));
    expect(await screen.findByText("Not permitted by the OS")).toBeTruthy();
  });

  it("records a hotkey as a single-action patch and shows field errors", async () => {
    update.mockRejectedValue({ cause: JSON.stringify({ code: "validation", message: "bad", fields: { "hotkeys.clipboard": "Already used" } }) });
    render(<SettingsView />);
    const rec = screen.getByRole("button", { name: "Open clipboard history shortcut" });
    fireEvent.click(rec);
    fireEvent.keyDown(rec, { key: "k", code: "KeyK", ctrlKey: true, altKey: true });
    expect(update).toHaveBeenCalledWith({ hotkeys: { clipboard: "CmdOrCtrl+Alt+K" } });
    expect(await screen.findByText("Already used")).toBeTruthy();
  });

  it("shows hotkey status badges", async () => {
    useSettings.setState({ settings: { ...defaultSettings(), hotkeys: { clipboard: DEFAULT_HOTKEYS.clipboard ?? "", quickOpen: "" } } });
    useDesktop.setState({
      hotkeys: [{ action: "clipboard", accelerator: "CmdOrCtrl+Alt+V", registered: false, error: "taken" }],
    });
    render(<SettingsView />);
    expect(screen.getByText("In use by another app")).toBeTruthy();
    expect(screen.getAllByText("Disabled")).toHaveLength(2);
    useDesktop.setState({ hotkeys: [{ action: "clipboard", accelerator: "CmdOrCtrl+Alt+V", registered: true, error: "" }] });
    expect(await screen.findByText("Active")).toBeTruthy();
  });

  it("resets shortcuts to defaults", () => {
    useSettings.setState({ settings: { ...defaultSettings(), hotkeys: { clipboard: "", quickOpen: "CmdOrCtrl+Alt+Q" } } });
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(update).toHaveBeenCalledWith({ hotkeys: DEFAULT_HOTKEYS });
  });

  it("installs ExifTool from the dependencies table", async () => {
    updateExiftool.mockResolvedValue({ id: "j1", moduleId: "system-exiftool-update", status: "queued", inputs: null, outputs: null });
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(updateExiftool).toHaveBeenCalled());
  });
});
