import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  Disk: vi.fn(),
  Install: vi.fn(),
  PickToolsDir: vi.fn(),
  Relaunch: vi.fn(),
  FinishSetup: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, PacksService: { ...api, List: async () => [], ToolsDir: async () => null } };
});

import { JobStatus, PackState, type Job } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import { usePacks } from "@/state/packs";
import { defaultSettings, useSettings } from "@/state/settings";
import { useUI } from "@/state/ui";
import { pack, samplePacks } from "./packFixtures";
import { SetupView } from "./SetupView";

function job(id: string, packId: string, status: JobStatus, extra: Partial<Job> = {}): Job {
  return {
    id,
    moduleId: "system-pack-install",
    title: `Install ${packId} pack`,
    status,
    progress: 0,
    message: "",
    inputs: null,
    optionsJson: JSON.stringify({ pack: packId }),
    errorCode: "",
    error: "",
    errorHint: "",
    attempt: 1,
    cancelRequested: false,
    createdAt: Date.now() + 1000,
    startedAt: 0,
    finishedAt: 0,
    outputs: null,
    resultJson: "",
    ...extra,
  } as Job;
}

const GB = 1e9;

function setup(packs = samplePacks(), disk = { path: "D:\\Tools", free: 100 * GB, total: 500 * GB }) {
  api.Disk.mockResolvedValue(disk);
  usePacks.setState({
    list: packs,
    byId: Object.fromEntries(packs.map((p) => [p.id, p])),
    loaded: true,
    toolsDir: { path: "D:\\Tools", isDefault: false, fromEnv: false, available: true },
  });
  const user = userEvent.setup();
  const utils = render(<SetupView />);
  return { user, ...utils };
}

const card = (name: string) => screen.getByRole("button", { name });

describe("SetupView", () => {
  beforeEach(() => {
    Object.values(api).forEach((m) => m.mockReset());
    api.Install.mockResolvedValue({ jobs: [], restart: false });
    api.FinishSetup.mockResolvedValue(undefined);
    api.Relaunch.mockResolvedValue(undefined);
    useJobs.getState().setAll([]);
    useSettings.setState({ settings: { ...defaultSettings(), setup: { done: false } } });
    useUI.setState({ view: "downloader" });
  });

  it("pre-selects Media and toggles cards, updating the Install label", async () => {
    const { user } = setup();
    expect(card("Media").getAttribute("aria-pressed")).toBe("true");
    expect(card("Music").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Install 1 pack · 320 MB" })).toBeTruthy();

    await user.click(card("Music"));
    expect(card("Music").getAttribute("aria-pressed")).toBe("true");
    // FFmpeg is counted once: 320 MB + engine 1.6 GB + stems 80 MB.
    expect(screen.getByRole("button", { name: "Install 2 packs · 2.0 GB" })).toBeTruthy();
    // The shared FFmpeg row on Music says who pays for it.
    expect(within(document.querySelector('[data-pack="music"]') as HTMLElement).getByText("with Media")).toBeTruthy();

    await user.click(card("Media"));
    await user.click(card("Music"));
    const install = screen.getByRole("button", { name: "Install" }) as HTMLButtonElement;
    expect(install.disabled).toBe(true);
  });

  it("shows installed and unsupported packs as non-selectable", async () => {
    const packs = samplePacks();
    packs[1] = { ...packs[1]!, state: PackState.PackInstalled };
    packs[2] = { ...packs[2]!, state: PackState.PackUnsupported, unsupportedReason: "No build for this CPU" };
    const { user } = setup(packs);
    expect(screen.getByText("Installed")).toBeTruthy();
    expect(screen.getByText("Not available on this computer")).toBeTruthy();
    for (const name of ["Music", "Image"]) {
      expect(card(name).getAttribute("aria-disabled")).toBe("true");
      expect(card(name).hasAttribute("aria-pressed")).toBe(false);
      await user.click(card(name));
    }
    // Nothing is pre-selected once something is installed.
    expect((screen.getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(card("Media"));
    expect(screen.getByRole("button", { name: "Install 1 pack · 320 MB" })).toBeTruthy();
  });

  it("warns when the selection does not fit and disables Install", async () => {
    setup(samplePacks(), { path: "D:\\Tools", free: 200e6, total: 500 * GB });
    expect(await screen.findByText("Not enough space on this drive")).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Install 1 pack/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("warns under 5 GB left but keeps Install enabled", async () => {
    setup(samplePacks(), { path: "D:\\Tools", free: 3 * GB, total: 500 * GB });
    expect(await screen.findByText("That leaves less than 5 GB free")).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Install 1 pack/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("moves focus with the arrow keys, toggles with Space and installs with Ctrl+Enter", async () => {
    const { user } = setup();
    card("Media").focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(card("Music"));
    await user.keyboard(" ");
    expect(card("Music").getAttribute("aria-pressed")).toBe("true");
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(card("Media"));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(api.Install).toHaveBeenCalledWith(["media", "music"], ""));
    // Ctrl+Enter must not have toggled the focused card.
    expect(card("Media").getAttribute("aria-pressed")).toBe("true");
  });

  it("starts an install, shows per-card progress and 'Installing 1 of 2'", async () => {
    const { user } = setup();
    await user.click(card("Music"));
    await user.click(screen.getByRole("button", { name: /^Install 2 packs/ }));
    await waitFor(() => expect(api.Install).toHaveBeenCalledWith(["media", "music"], ""));

    act(() => {
      useJobs.getState().upsert(job("j1", "media", JobStatus.JobRunning, { progress: 0.4, message: "Downloading FFmpeg · 48 of 115 MB" }));
      useJobs.getState().upsert(job("j2", "music", JobStatus.JobQueued));
    });
    expect(screen.getByText("Installing 1 of 2")).toBeTruthy();
    const media = document.querySelector('[data-pack="media"]') as HTMLElement;
    expect(within(media).getByText("Downloading FFmpeg · 48 of 115 MB")).toBeTruthy();
    expect(within(media).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");
    expect(within(document.querySelector('[data-pack="music"]') as HTMLElement).getByText("Waiting")).toBeTruthy();
    // Cards stop toggling while installing.
    await user.click(card("Image"));
    expect(card("Image").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Continue in background" })).toBeTruthy();
  });

  it("shows a failed pack with its message and Retry, while the others carry on", async () => {
    const { user } = setup();
    await user.click(card("Music"));
    await user.click(screen.getByRole("button", { name: /^Install 2 packs/ }));
    act(() => {
      useJobs.getState().upsert(job("j1", "media", JobStatus.JobFailed, { error: "FFmpeg: the download was corrupted", errorHint: "Try again" }));
      useJobs.getState().upsert(job("j2", "music", JobStatus.JobRunning, { progress: 0.1, message: "Setting up the AI engine…" }));
    });
    const media = document.querySelector('[data-pack="media"]') as HTMLElement;
    expect(within(media).getByText("FFmpeg: the download was corrupted")).toBeTruthy();
    expect(screen.getByText("Setting up the AI engine…")).toBeTruthy();

    api.Install.mockClear();
    await user.click(within(media).getByRole("button", { name: "Retry" }));
    expect(api.Install).toHaveBeenCalledWith(["media"], "");
  });

  it("offers Open Toolbox when everything finished and opens the first installed tool", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /^Install 1 pack/ }));
    act(() => {
      useJobs.getState().upsert(job("j1", "media", JobStatus.JobDone, { progress: 1 }));
    });
    await user.click(await screen.findByRole("button", { name: "Open Toolbox" }));
    expect(api.FinishSetup).toHaveBeenCalled();
    expect(useSettings.getState().settings.setup.done).toBe(true);
    expect(useUI.getState().view).toBe("downloader");
  });

  it("Continue in background finishes setup", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /^Install 1 pack/ }));
    await user.click(screen.getByRole("button", { name: "Continue in background" }));
    expect(api.FinishSetup).toHaveBeenCalled();
    expect(useSettings.getState().settings.setup.done).toBe(true);
  });

  it("Skip for now finishes setup and opens the Library", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(api.FinishSetup).toHaveBeenCalled();
    expect(useSettings.getState().settings.setup.done).toBe(true);
    expect(useUI.getState().view).toBe("library");
  });

  it("changes the location and relaunches when Install asks for a restart", async () => {
    api.PickToolsDir.mockResolvedValue("E:\\Toolbox Tools");
    api.Install.mockResolvedValue({ jobs: null, restart: true });
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Change…" }));
    await waitFor(() => expect(api.Disk).toHaveBeenCalledWith("E:\\Toolbox Tools"));
    await user.click(screen.getByRole("button", { name: /^Install 1 pack/ }));
    await waitFor(() => expect(api.Install).toHaveBeenCalledWith(["media"], "E:\\Toolbox Tools"));
    await waitFor(() => expect(api.Relaunch).toHaveBeenCalled());
  });

  it("closes the overlay with Escape", async () => {
    const onClose = vi.fn();
    api.Disk.mockResolvedValue({ path: "", free: 1, total: 2 });
    usePacks.setState({ list: [pack("media", "Media", PackState.PackInstalled, [])], loaded: true, toolsDir: null });
    const user = userEvent.setup();
    render(<SetupView overlay onClose={onClose} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
