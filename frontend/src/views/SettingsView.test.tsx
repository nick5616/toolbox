import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    LibraryService: {
      OpenLibraryFolder: vi.fn().mockResolvedValue(undefined),
      RevealPath: vi.fn().mockResolvedValue(undefined),
    },
    SettingsService: {
      ChooseLibraryDir: vi.fn().mockResolvedValue("/new/lib"),
    },
  };
});

import { DepSource, DepState, Theme, type DepStatus, type Settings, type SettingsPatch } from "@/lib/api";
import { useDeps } from "@/state/deps";
import { defaultSettings, useSettings } from "@/state/settings";
import { SettingsView } from "./SettingsView";

function dep(id: string, name: string, state: DepState): DepStatus {
  return {
    id,
    name,
    purpose: "p",
    state,
    version: "1.0",
    path: state === DepState.DepOK ? `/bin/${id}` : "",
    source: DepSource.SourcePath,
    required: true,
    requiredBy: ["downloader"],
    recommendedBy: null,
    installHint: `install ${id}`,
    error: "",
  } as DepStatus;
}

describe("SettingsView", () => {
  let update: Mock<(p: Partial<SettingsPatch>) => Promise<Settings>>;

  beforeEach(() => {
    update = vi.fn<(p: Partial<SettingsPatch>) => Promise<Settings>>().mockResolvedValue({} as Settings);
    useSettings.setState({
      update,
      settings: { ...defaultSettings(), libraryDir: "/lib" },
      appInfo: null,
    });
    useDeps.getState().setAll([
      dep("yt-dlp", "yt-dlp", DepState.DepMissing),
      dep("ffmpeg", "ffmpeg", DepState.DepMissing),
    ]);
  });

  it("updates concurrency from the stepper", () => {
    render(<SettingsView />);
    const jobs = screen.getByRole("region", { name: "Jobs" });
    fireEvent.click(within(jobs).getByRole("button", { name: "Increase" }));
    expect(update).toHaveBeenCalledWith({ concurrency: 4 });
  });

  it("updates theme", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(update).toHaveBeenCalledWith({ theme: Theme.ThemeLight });
  });

  it("shows install actions for missing tools", () => {
    render(<SettingsView />);
    // yt-dlp and the managed FFmpeg both get an Install action (SPEC 7.6).
    expect(screen.getAllByRole("button", { name: "Install" })).toHaveLength(2);
  });

  it("shows ffprobe as installed with FFmpeg and without buttons", () => {
    useDeps.getState().setAll([dep("ffprobe", "ffprobe", DepState.DepMissing)]);
    render(<SettingsView />);
    const row = screen.getByText("ffprobe").closest("tr") as HTMLElement;
    expect(within(row).getByText("Installed with FFmpeg")).toBeTruthy();
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
  });

  it("changes the library dir from the dialog result", async () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ libraryDir: "/new/lib" }));
  });
});
