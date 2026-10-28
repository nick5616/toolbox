import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({
  State: vi.fn(),
  ChangePassphrase: vi.fn(),
  RecoveryKey: vi.fn(),
}));
const revealPath = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/lib/events", () => ({ on: () => () => undefined }));
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, VaultService: svc, LibraryService: { RevealPath: revealPath } };
});

import type { Settings, SettingsPatch } from "@/lib/api";
import { defaultSettings, useSettings } from "@/state/settings";
import { SettingsVault } from "./SettingsVault";

describe("SettingsVault", () => {
  const update = vi.fn<(p: Partial<SettingsPatch>) => Promise<Settings>>();

  beforeEach(() => {
    update.mockReset().mockResolvedValue({} as Settings);
    svc.State.mockReset().mockResolvedValue({ exists: true, unlocked: false, entries: 0, autoLockMinutes: 10, lockAt: 0 });
    svc.ChangePassphrase.mockReset().mockResolvedValue(undefined);
    svc.RecoveryKey.mockReset().mockResolvedValue("AGE-SECRET-KEY-1QQ");
    revealPath.mockClear();
    useSettings.setState({ update, settings: { ...defaultSettings(), libraryDir: "/lib" } });
  });

  it("saves the auto-lock choice", async () => {
    const user = userEvent.setup();
    render(<SettingsVault />);
    await user.selectOptions(screen.getByLabelText("Auto-lock"), "30");
    expect(update).toHaveBeenCalledWith({ vault: { autoLockMinutes: 30 } });
  });

  it("asks for the passphrase before showing the recovery key", async () => {
    const user = userEvent.setup();
    render(<SettingsVault />);
    const btn = await screen.findByRole("button", { name: "Show recovery key…" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    await user.click(btn);
    await user.type(screen.getByLabelText("Passphrase"), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Show key" }));
    await waitFor(() => expect(svc.RecoveryKey).toHaveBeenCalledWith("hunter2hunter2"));
    expect((await screen.findByTestId("recovery-key")).textContent).toBe("AGE-SECRET-KEY-1QQ");
  });

  it("validates and changes the passphrase", async () => {
    const user = userEvent.setup();
    render(<SettingsVault />);
    const btn = await screen.findByRole("button", { name: "Change passphrase…" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    await user.click(btn);
    await user.type(screen.getByLabelText("Current passphrase"), "old-passphrase");
    await user.type(screen.getByLabelText("New passphrase"), "new-passphrase");
    await user.type(screen.getByLabelText("Confirm new passphrase"), "different-one");
    await user.click(screen.getByRole("button", { name: "Change passphrase" }));
    expect((await screen.findByRole("alert")).textContent).toContain("don't match");
    expect(svc.ChangePassphrase).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText("Confirm new passphrase"));
    await user.type(screen.getByLabelText("Confirm new passphrase"), "new-passphrase");
    await user.click(screen.getByRole("button", { name: "Change passphrase" }));
    await waitFor(() => expect(svc.ChangePassphrase).toHaveBeenCalledWith("old-passphrase", "new-passphrase"));
  }, 20_000);

  it("reveals the vault folder inside the library", async () => {
    const user = userEvent.setup();
    render(<SettingsVault />);
    const btn = await screen.findByRole("button", { name: "Reveal vault folder" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    await user.click(btn);
    expect(revealPath).toHaveBeenCalledWith("/lib/Vault");
  });
});
