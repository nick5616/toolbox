import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const svc = vi.hoisted(() => ({ Catalog: vi.fn(), DeleteModel: vi.fn(), DownloadModel: vi.fn() }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, ChatService: svc };
});

import type { ChatModelInfo, Settings, SettingsPatch } from "@/lib/api";
import { defaultSettings, useSettings } from "@/state/settings";
import { SettingsChat } from "./SettingsChat";

const model = (over: Partial<ChatModelInfo> = {}): ChatModelInfo => ({
  id: "qwen3-4b",
  label: "Qwen3 4B Instruct",
  bytes: 2_497_281_120,
  license: "Apache-2.0",
  hint: "",
  isDefault: true,
  verified: true,
  installed: true,
  jobId: "",
  ollama: false,
  ...over,
});

describe("SettingsChat", () => {
  let update: Mock<(p: Partial<SettingsPatch>) => Promise<Settings>>;

  beforeEach(() => {
    for (const f of Object.values(svc)) f.mockReset();
    svc.Catalog.mockResolvedValue([model()]);
    svc.DeleteModel.mockResolvedValue(undefined);
    update = vi.fn<(p: Partial<SettingsPatch>) => Promise<Settings>>().mockResolvedValue({} as Settings);
    useSettings.setState({ update, settings: defaultSettings() });
  });

  it("saves the context size, GPU switch and shows the Ollama note", async () => {
    const user = userEvent.setup();
    render(<SettingsChat />);
    await user.selectOptions(screen.getByLabelText("Context size"), "16384");
    expect(update).toHaveBeenLastCalledWith({ chat: { ...defaultSettings().chat, contextSize: 16384 } });
    await user.click(screen.getByRole("switch", { name: "Use GPU" }));
    expect(update).toHaveBeenLastCalledWith({ chat: { ...defaultSettings().chat, gpu: false } });
    expect(screen.getByText("Ollama has no access control; any app on this computer can use it.")).toBeTruthy();
  });

  it("tests the Ollama URL and reports whether models appear", async () => {
    const user = userEvent.setup();
    svc.Catalog.mockResolvedValue([model(), model({ id: "ollama:llama3", label: "llama3", ollama: true })]);
    render(<SettingsChat />);
    await user.type(screen.getByLabelText("Ollama URL"), "http://127.0.0.1:11434");
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(update).toHaveBeenCalledWith({ chat: { ...defaultSettings().chat, ollamaURL: "http://127.0.0.1:11434" } });
    expect(await screen.findByText("Connected. 1 Ollama model found.")).toBeTruthy();
  });

  it("warns when no Ollama models appear", async () => {
    const user = userEvent.setup();
    render(<SettingsChat />);
    await user.type(screen.getByLabelText("Ollama URL"), "http://localhost:11434");
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect((await screen.findByText(/No Ollama models found/)).textContent).toContain("Is Ollama running");
  });

  it("shows a validation error from the URL field", async () => {
    const user = userEvent.setup();
    update.mockRejectedValue({ code: "validation", message: "Invalid", fields: { ollamaURL: "Use a local address" } });
    render(<SettingsChat />);
    await user.type(screen.getByLabelText("Ollama URL"), "http://example.com");
    await user.tab();
    expect(await screen.findByText("Use a local address")).toBeTruthy();
  });

  it("deletes an installed model after confirming", async () => {
    const user = userEvent.setup();
    render(<SettingsChat />);
    await user.click(await screen.findByRole("button", { name: "Delete Qwen3 4B Instruct" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(svc.DeleteModel).toHaveBeenCalledWith("qwen3-4b"));
  });
});
