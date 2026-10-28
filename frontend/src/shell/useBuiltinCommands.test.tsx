import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const openPopup = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, ClipboardService: { OpenPopup: () => openPopup(), Pause: vi.fn(), Resume: vi.fn() } };
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
