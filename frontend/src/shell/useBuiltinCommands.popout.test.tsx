import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const popOut = vi.hoisted(() => vi.fn(async (_a?: unknown) => undefined));
vi.mock("@/lib/events", () => ({ on: () => () => undefined }));
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    DesktopService: { ...actual.DesktopService, PopOut: (r: unknown) => popOut(r) },
    VaultService: { State: async () => null, Lock: vi.fn() },
  };
});

import { Category, ModuleStatus, type Descriptor } from "@/lib/api";
import { enabledCommands, useCommandRegistry } from "@/lib/commands";
import { useModules } from "@/state/modules";
import { useBuiltinCommands } from "./useBuiltinCommands";

function mod(id: string, name: string, extra: Partial<Descriptor> = {}): Descriptor {
  return {
    id, name, tagline: "", description: "", icon: "box", category: Category.$zero, status: ModuleStatus.StatusReady,
    accepts: { extensions: null, urls: false, any: false }, requires: null, recommends: null, outputSubdir: "", order: 1, hidden: false, jobLess: false, maxInputs: 0, base: "", parts: null,
    ...extra,
  };
}

describe("pop-out palette commands", () => {
  beforeEach(() => {
    popOut.mockClear();
    useCommandRegistry.setState({ commands: {} });
    useModules.getState().setAll([
      mod("a", "Alpha"),
      mod("b", "Beta", { hidden: true }),
      mod("c", "Gamma", { status: ModuleStatus.StatusComingSoon }),
    ]);
  });

  it("adds one command per visible ready tool", async () => {
    renderHook(() => useBuiltinCommands());
    const titles = enabledCommands().map((c) => c.title);
    expect(titles).toContain("Open Alpha in its own window");
    expect(titles).not.toContain("Open Beta in its own window");
    expect(titles).not.toContain("Open Gamma in its own window");
    await useCommandRegistry.getState().commands["window.pop-out.a"]?.run();
    expect(popOut).toHaveBeenCalledWith(expect.objectContaining({ key: "tool:a", title: "Alpha — Toolbox" }));
  });
});
