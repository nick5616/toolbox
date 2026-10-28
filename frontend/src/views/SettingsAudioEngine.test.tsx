import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const install = vi.fn();
const remove = vi.fn();
const clearModels = vi.fn();
const updateUv = vi.fn();
const usage = vi.fn();

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    DepsService: {
      InstallAudioEngine: () => install(),
      RemoveAudioEngine: () => remove(),
      ClearModels: () => clearModels(),
      UpdateUv: () => updateUv(),
      ModelsUsage: () => usage(),
      Recheck: vi.fn().mockResolvedValue([]),
    },
    LibraryService: { OpenLibraryFolder: vi.fn(), RevealPath: vi.fn() },
    SettingsService: { ChooseLibraryDir: vi.fn() },
  };
});

import { DepSource, DepState, type DepStatus } from "@/lib/api";
import { useDeps } from "@/state/deps";
import { useJobs } from "@/state/jobs";
import { defaultSettings, useSettings } from "@/state/settings";
import { SettingsView } from "./SettingsView";

function dep(id: string, state: DepState): DepStatus {
  return {
    id,
    name: id,
    purpose: "p",
    state,
    version: "1.0",
    path: "",
    source: DepSource.SourceManaged,
    required: false,
    requiredBy: [],
    recommendedBy: null,
    installHint: "",
    error: "",
  } as unknown as DepStatus;
}

const job = { id: "j1", moduleId: "system-audio-engine", status: "queued", inputs: null, outputs: null };

describe("Settings audio engine", () => {
  beforeEach(() => {
    [install, remove, clearModels, updateUv, usage].forEach((m) => m.mockReset());
    install.mockResolvedValue(job);
    remove.mockResolvedValue(undefined);
    clearModels.mockResolvedValue(undefined);
    updateUv.mockResolvedValue({ ...job, moduleId: "system-uv" });
    usage.mockResolvedValue(2048);
    useJobs.getState().setAll([]);
    useSettings.setState({ settings: { ...defaultSettings(), libraryDir: "/lib" }, appInfo: null });
  });

  it("installs when missing", async () => {
    useDeps.getState().setAll([dep("audio-engine", DepState.DepMissing)]);
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(install).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("offers Update when outdated, with an amber Update chip", async () => {
    useDeps.getState().setAll([dep("audio-engine", DepState.DepOutdated)]);
    render(<SettingsView />);
    expect(screen.getAllByText("Update").length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Update" })[0]!);
    await waitFor(() => expect(install).toHaveBeenCalled());
  });

  it("repairs when ok and removes only after confirming", async () => {
    useDeps.getState().setAll([dep("audio-engine", DepState.DepOK)]);
    render(<SettingsView />);
    expect(screen.getByRole("button", { name: "Repair" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText(/frees about 1.4 GB/)).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(remove).toHaveBeenCalled());
  });

  it("clears models after confirming and refreshes usage", async () => {
    useDeps.getState().setAll([dep("audio-engine", DepState.DepOK)]);
    render(<SettingsView />);
    await screen.findByText(/Models: 2\.0 KiB/);
    fireEvent.click(screen.getByRole("button", { name: "Clear models" }));
    usage.mockResolvedValue(0);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clear models" }));
    await waitFor(() => expect(clearModels).toHaveBeenCalled());
    await waitFor(() => expect(usage).toHaveBeenCalledTimes(2));
  });

  it("updates uv", async () => {
    useDeps.getState().setAll([dep("uv", DepState.DepOK)]);
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(updateUv).toHaveBeenCalled());
  });
});
