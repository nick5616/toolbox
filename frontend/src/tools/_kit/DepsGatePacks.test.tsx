import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ InstallFor: vi.fn(), Install: vi.fn(), Relaunch: vi.fn() }));
const chat = vi.hoisted(() => ({ Catalog: vi.fn(), DownloadModel: vi.fn() }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, PacksService: api, ChatService: chat };
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
    // One banner names what is missing and carries the pack buttons (polish rule 3).
    expect(screen.getByText(/isn.t installed$/)).toBeTruthy();
  });

  it("shows one button when the pack is exactly what the tool needs", async () => {
    const M = PackComponentState.ComponentMissing;
    const same = [pack("image", "Image", PackState.PackMissing, [comp("engine", M, 1600e6, ["image"]), comp("bg-default", M, 220e6, ["image"], PackComponentKind.ComponentModel)], ["bgremove"])];
    usePacks.setState({ list: same, byId: { image: same[0]! }, loaded: true });
    const user = userEvent.setup();
    render(<DepsGate moduleId="bgremove" />);
    expect(screen.getAllByRole("button", { name: /Install/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Install the Image pack/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Install what this tool needs (1.8 GB)" }));
    await waitFor(() => expect(api.InstallFor).toHaveBeenCalledWith("bgremove"));
  });

  it("downloads the default chat model along with Local Chat's engine", async () => {
    chat.Catalog.mockReset().mockResolvedValue([{ id: "m1", isDefault: true, installed: false, ollama: false, jobId: "" }]);
    chat.DownloadModel.mockReset().mockResolvedValue({ id: "jm", moduleId: "system-chat-model", status: "queued", inputs: null, outputs: null });
    useModules.setState({ byId: { "llm-chat": { id: "llm-chat", requires: ["llama-server"] } } } as unknown as Parameters<typeof useModules.setState>[0]);
    useDeps.getState().setAll([dep("llama-server", DepState.DepMissing)]);
    const M = PackComponentState.ComponentMissing;
    const packs = [pack("chat", "Chat", PackState.PackMissing, [comp("llama-server", M, 100e6, ["chat"])], ["llm-chat"])];
    usePacks.setState({ list: packs, byId: { chat: packs[0]! }, loaded: true });
    const user = userEvent.setup();
    render(<DepsGate moduleId="llm-chat" />);
    await user.click(screen.getByRole("button", { name: /Install what this tool needs/ }));
    await waitFor(() => expect(api.InstallFor).toHaveBeenCalledWith("llm-chat"));
    await waitFor(() => expect(chat.DownloadModel).toHaveBeenCalledWith("m1"));
  });

  it("hides the buttons when the pack is unsupported", () => {
    const p = usePacks.getState().list[0]!;
    usePacks.setState({ list: [{ ...p, state: PackState.PackUnsupported }] });
    render(<DepsGate moduleId="bgremove" />);
    expect(screen.queryByRole("button", { name: /Install what this tool needs/ })).toBeNull();
  });
});
