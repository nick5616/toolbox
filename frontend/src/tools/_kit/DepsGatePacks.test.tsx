import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ InstallFor: vi.fn(), Install: vi.fn(), Relaunch: vi.fn() }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, PacksService: api };
});

import { DepSource, DepState, PackState, type DepStatus } from "@/lib/api";
import { useDeps } from "@/state/deps";
import { useModules } from "@/state/modules";
import { usePacks } from "@/state/packs";
import { comp, pack } from "@/views/setup/packFixtures";
import { PackComponentKind, PackComponentState } from "@/lib/api";
import { DepsGate } from "./DepsGate";

function dep(id: string, state: DepState): DepStatus {
  return {
    id,
    name: id,
    purpose: "",
    state,
    version: "",
    path: "",
    source: DepSource.SourceManaged,
    required: true,
    requiredBy: ["bgremove"],
    recommendedBy: null,
    installHint: "",
    error: "",
  } as unknown as DepStatus;
}

describe("DepsGate pack buttons", () => {
  beforeEach(() => {
    Object.values(api).forEach((m) => m.mockReset());
    api.InstallFor.mockResolvedValue({ id: "j1", moduleId: "system-pack-install", status: "queued", inputs: null, outputs: null });
    api.Install.mockResolvedValue({ jobs: [], restart: false });
    useModules.setState({
      byId: { bgremove: { id: "bgremove", requires: ["audio-engine"] } },
    } as unknown as Parameters<typeof useModules.setState>[0]);
    useDeps.getState().setAll([dep("audio-engine", DepState.DepMissing)]);
    const M = PackComponentState.ComponentMissing;
    const packs = [
      pack(
        "image",
        "Image",
        PackState.PackMissing,
        [comp("engine", M, 1600e6, ["image"]), comp("bg-default", M, 220e6, ["image"], PackComponentKind.ComponentModel), comp("exiftool", M, 35e6, ["image"])],
        ["bgremove"],
      ),
    ];
    usePacks.setState({ list: packs, byId: { image: packs[0]! }, loaded: true });
  });

  it("shows both install buttons with sizes and calls the right services", async () => {
    const user = userEvent.setup();
    render(<DepsGate moduleId="bgremove" />);
    // Engine + the pack's model: 1.6 GB + 220 MB.
    const needs = screen.getByRole("button", { name: "Install what this tool needs (1.8 GB)" });
    const whole = screen.getByRole("button", { name: "Install the Image pack (1.9 GB)" });
    await user.click(needs);
    await waitFor(() => expect(api.InstallFor).toHaveBeenCalledWith("bgremove"));
    await user.click(whole);
    await waitFor(() => expect(api.Install).toHaveBeenCalledWith(["image"], ""));
    // The existing per-dependency banner is still there.
    expect(screen.getByText("The AI engine isn't installed")).toBeTruthy();
  });

  it("hides the buttons when the pack is unsupported", () => {
    const p = usePacks.getState().list[0]!;
    usePacks.setState({ list: [{ ...p, state: PackState.PackUnsupported }] });
    render(<DepsGate moduleId="bgremove" />);
    expect(screen.queryByRole("button", { name: /Install what this tool needs/ })).toBeNull();
  });
});
