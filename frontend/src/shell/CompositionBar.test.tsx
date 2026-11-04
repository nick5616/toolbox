import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const popOut = vi.hoisted(() => vi.fn(async (_a?: unknown) => undefined));
const showMain = vi.hoisted(() => vi.fn(async (_a?: unknown) => undefined));
vi.mock("@/lib/events", () => ({ on: () => () => undefined }));
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, DesktopService: { ...actual.DesktopService, PopOut: (r: unknown) => popOut(r), ShowMain: (v: string) => showMain(v) } };
});

import { Category, ModuleStatus, type Descriptor } from "@/lib/api";
import { setCurrentWindowForTest } from "@/lib/windows";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { CompositionBar } from "./CompositionBar";

function mod(id: string, name: string, order: number, extra: Partial<Descriptor> = {}): Descriptor {
  return {
    id, name, tagline: "", description: "", icon: "box", category: Category.$zero, status: ModuleStatus.StatusReady,
    accepts: { extensions: null, urls: false, any: false }, requires: null, recommends: null, outputSubdir: "", order, hidden: false, jobLess: false, maxInputs: 0, base: "", parts: null,
    ...extra,
  };
}

describe("CompositionBar", () => {
  beforeEach(() => {
    popOut.mockClear();
    showMain.mockClear();
    setCurrentWindowForTest(null);
    useModules.getState().setAll([
      mod("editor", "Video Editor", 1, { parts: ["sequence", "remover"] }),
      mod("studio", "Edit Studio", 2, { base: "editor", parts: ["remover"] }),
      mod("sequence", "Sequence Editor", 3, { hidden: true }),
      mod("remover", "Background Remover", 4),
      mod("plain", "Plain", 5),
    ]);
    useUI.setState({ view: "editor" });
  });

  it("shows variants and parts (hidden parts too) for a baseline", () => {
    render(<CompositionBar view="editor" />);
    expect(screen.getByRole("group", { name: "Variants" }).textContent).toContain("Edit Studio");
    const uses = screen.getByRole("group", { name: "Uses" });
    expect(uses.textContent).toContain("Sequence Editor");
    expect(uses.textContent).toContain("Background Remover");
    expect(screen.queryByRole("group", { name: "Built on" })).toBeNull();
  });

  it("shows the base for a variant", () => {
    render(<CompositionBar view="studio" />);
    expect(screen.getByRole("group", { name: "Built on" }).textContent).toContain("Video Editor");
    expect(screen.queryByRole("group", { name: "Variants" })).toBeNull();
  });

  it("renders nothing for tools without composition and for non-module views", () => {
    const a = render(<CompositionBar view="plain" />);
    expect(a.container.innerHTML).toBe("");
    const b = render(<CompositionBar view="settings" />);
    expect(b.container.innerHTML).toBe("");
  });

  it("navigates on click in the main window", () => {
    render(<CompositionBar view="studio" />);
    fireEvent.click(screen.getByText("Video Editor"));
    expect(useUI.getState().view).toBe("editor");
    expect(popOut).not.toHaveBeenCalled();
  });

  it("pops out on Shift+click and on the hover button", () => {
    render(<CompositionBar view="studio" />);
    fireEvent.click(screen.getByText("Video Editor"), { shiftKey: true });
    expect(popOut).toHaveBeenCalledTimes(1);
    expect(popOut).toHaveBeenLastCalledWith(expect.objectContaining({ key: "tool:editor", title: "Video Editor — Toolbox" }));
    expect(useUI.getState().view).toBe("editor");
    fireEvent.click(screen.getByRole("button", { name: "Open Video Editor in its own window" }));
    expect(popOut).toHaveBeenCalledTimes(2);
  });

  it("asks the main window to navigate from a tool window", () => {
    setCurrentWindowForTest({ kind: "tool", key: "tool:studio", view: "studio", part: "", params: new URLSearchParams() });
    useUI.setState({ view: "studio" });
    render(<CompositionBar view="studio" />);
    fireEvent.click(screen.getByText("Video Editor"));
    expect(showMain).toHaveBeenCalledWith("editor");
    expect(useUI.getState().view).toBe("studio");
    setCurrentWindowForTest(null);
  });
});
