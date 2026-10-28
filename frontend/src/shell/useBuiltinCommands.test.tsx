import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const openPopup = vi.hoisted(() => vi.fn(async () => undefined));
const vaultState = vi.hoisted(() => vi.fn());
const vaultLock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/events", () => ({ on: () => () => undefined }));
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, ClipboardService: { OpenPopup: () => openPopup(), Pause: vi.fn(), Resume: vi.fn() },
    VaultService: { State: () => vaultState(), Lock: () => vaultLock() },
  };
});

import { enabledCommands, useCommandRegistry } from "@/lib/commands";
import { useDesktop } from "@/state/desktop";
import { defaultSettings, useSettings } from "@/state/settings";
import { useUI } from "@/state/ui";
import { useBuiltinCommands } from "./useBuiltinCommands";

const ids = () => enabledCommands().map((c) => c.id);

describe("clipboard palette commands", () => {
  beforeEach(() => {
    useCommandRegistry.setState({ commands: {} });
    useDesktop.setState({ clipboard: { recording: true, paused: false, error: "" } });
    useSettings.setState({ settings: { ...defaultSettings(), clipboard: { ...defaultSettings().clipboard, enabled: true } } });
  });

  it("offers open/pause/clear while recording", () => {
    renderHook(() => useBuiltinCommands());
    expect(ids()).toEqual(expect.arrayContaining(["clipboard.open", "clipboard.pause", "clipboard.clear"]));
    expect(ids()).not.toContain("clipboard.resume");
  });

  it("offers resume when paused", () => {
    useDesktop.setState({ clipboard: { recording: false, paused: true, error: "" } });
    renderHook(() => useBuiltinCommands());
    expect(ids()).toContain("clipboard.resume");
    expect(ids()).not.toContain("clipboard.pause");
  });

  it("hides pause/resume when history is disabled", () => {
    useSettings.setState({ settings: defaultSettings() });
    renderHook(() => useBuiltinCommands());
    expect(ids()).not.toContain("clipboard.pause");
    expect(ids()).not.toContain("clipboard.resume");
  });

  it("runs open and clear", async () => {
    renderHook(() => useBuiltinCommands());
    const cmds = useCommandRegistry.getState().commands;
    await cmds["clipboard.open"]?.run();
    expect(openPopup).toHaveBeenCalled();
    await cmds["clipboard.clear"]?.run();
    expect(useUI.getState().view).toBe("clipboard");
  });
});

describe("Phase 5 palette commands", () => {
  beforeEach(() => {
    useCommandRegistry.setState({ commands: {} });
    vaultState.mockReset().mockResolvedValue({ exists: true, unlocked: false, entries: 0, autoLockMinutes: 10, lockAt: 0 });
    vaultLock.mockClear();
    useUI.setState({ view: "library" });
  });

  it("navigates for chat, vault and setup entries", async () => {
    renderHook(() => useBuiltinCommands());
    const cmds = useCommandRegistry.getState().commands;
    await cmds["chat.new"]?.run();
    expect(useUI.getState().view).toBe("llm-chat");
    useUI.getState().navigate("library");
    await cmds["chat.history"]?.run();
    expect(useUI.getState().view).toBe("llm-chat");
    await cmds["vault.open"]?.run();
    expect(useUI.getState().view).toBe("vault");
    await cmds["setup.show"]?.run();
    expect(useUI.getState().view).toBe("setup");
  });

  it("shows Lock vault only while unlocked and locks", async () => {
    renderHook(() => useBuiltinCommands());
    await waitFor(() => expect(vaultState).toHaveBeenCalled());
    expect(ids()).not.toContain("vault.lock");
    expect(ids()).toContain("vault.open");

    useCommandRegistry.setState({ commands: {} });
    vaultState.mockResolvedValue({ exists: true, unlocked: true, entries: 1, autoLockMinutes: 10, lockAt: 0 });
    renderHook(() => useBuiltinCommands());
    await waitFor(() => expect(ids()).toContain("vault.lock"));
    await useCommandRegistry.getState().commands["vault.lock"]?.run();
    expect(vaultLock).toHaveBeenCalled();
  });

  it("Manage tool packs opens Settings and scrolls to the packs section", async () => {
    const el = document.createElement("div");
    el.id = "settings-packs";
    const scroll = vi.fn();
    el.scrollIntoView = scroll;
    document.body.appendChild(el);
    renderHook(() => useBuiltinCommands());
    await useCommandRegistry.getState().commands["packs.manage"]?.run();
    expect(useUI.getState().view).toBe("settings");
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    el.remove();
  });
});
