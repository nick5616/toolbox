import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  Disk: vi.fn(),
  Install: vi.fn(),
  PickToolsDir: vi.fn(),
  MoveToolsDir: vi.fn(),
  Relaunch: vi.fn(),
  RemovePreview: vi.fn(),
  Remove: vi.fn(),
  List: vi.fn(),
  ToolsDir: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, PacksService: api };
});

import { PackComponentState, PackState } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import { usePacks } from "@/state/packs";
import { useUI } from "@/state/ui";
import { comp, pack, samplePacks } from "./setup/packFixtures";
import { SettingsPacks, removeBody } from "./SettingsPacks";

const I = PackComponentState.ComponentInstalled;

function load() {
  const packs = samplePacks();
  packs[1] = pack("music", "Music", PackState.PackInstalled, [comp("engine", I, 1600e6, ["music", "image"])], ["stems"]);
  packs[2] = pack("image", "Image", PackState.PackInstalled, [comp("engine", I, 1600e6, ["music", "image"])], ["bgremove"]);
  usePacks.setState({
    list: packs,
    loaded: true,
    toolsDir: { path: "D:\\Tools", isDefault: false, fromEnv: false, available: true },
  });
}

describe("SettingsPacks", () => {
  beforeEach(() => {
    Object.values(api).forEach((m) => m.mockReset());
    api.Disk.mockResolvedValue({ path: "D:\\Tools", free: 128e9, total: 476e9 });
    api.List.mockResolvedValue([]);
    api.ToolsDir.mockResolvedValue(null);
    api.Install.mockResolvedValue({ jobs: [], restart: false });
    api.Remove.mockResolvedValue(undefined);
    useJobs.getState().setAll([]);
    load();
  });

  it("confirms a removal from the RemovePreview", async () => {
    api.RemovePreview.mockResolvedValue({ freedBytes: 311e6, kept: [{ component: "The AI engine", usedBy: ["Music"] }] });
    const user = userEvent.setup();
    render(<SettingsPacks />);
    const image = screen.getByRole("article", { name: "Image pack" });
    await user.click(within(image).getByRole("button", { name: "Remove" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Remove the Image pack?")).toBeTruthy();
    expect(within(dialog).getByText("This frees 311 MB. The AI engine stays because Music uses it.")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.Remove).toHaveBeenCalledWith("image"));
  });

  it("builds the removal text for several owners", () => {
    expect(removeBody({ freedBytes: 1.1e9, kept: [{ component: "FFmpeg", usedBy: ["Media", "Music"] }] })).toBe(
      "This frees 1.1 GB. FFmpeg stays because Media and Music use it.",
    );
    expect(removeBody({ freedBytes: 5e6, kept: null })).toBe("This frees 5 MB.");
  });

  it("installs a missing pack and offers no Remove for it", async () => {
    const user = userEvent.setup();
    render(<SettingsPacks />);
    const media = screen.getByRole("article", { name: "Media pack" });
    expect(within(media).queryByRole("button", { name: "Remove" })).toBeNull();
    await user.click(within(media).getByRole("button", { name: "Install" }));
    expect(api.Install).toHaveBeenCalledWith(["media"], "");
  });

  it("shows the tools folder with free space, and the setup link", async () => {
    const user = userEvent.setup();
    render(<SettingsPacks />);
    expect(await screen.findByText("128 GB free")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move…" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show setup screen" }));
    expect(useUI.getState().view).toBe("setup");
    expect(document.getElementById("settings-packs")).toBeTruthy();
  });
});
