import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (orig) => {
  const { libraryApiMock } = await import("./testSvc");
  return libraryApiMock(orig as never);
});
vi.mock("@/lib/wholeImage", () => ({ wholeImageUrl: () => Promise.resolve("blob:x"), releaseImageUrl: () => undefined }));

import { JobStatus, ModuleStatus, type Descriptor } from "@/lib/api";
import { ToolHeader } from "@/components";
import { useToastStore } from "@/components/toast";
import { openLibrary } from "@/lib/openLibrary";
import { setCurrentWindowForTest } from "@/lib/windows";
import { useJobs } from "@/state/jobs";
import { useLibrary } from "@/state/library";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { notifyDone } from "@/shell/useJobToasts";
import { LibraryView } from "./LibraryView";
import { img, out, resetMocks, svc } from "./testFixtures";

function mod(id: string, name = id): Descriptor {
  return { id, name, icon: "box", status: ModuleStatus.StatusReady, accepts: { extensions: [], urls: false } } as unknown as Descriptor;
}

const lastQuery = () => svc.Query.mock.calls.at(-1)?.[0] as Record<string, unknown>;

describe("Library deep links", () => {
  beforeEach(() => {
    resetMocks();
    setCurrentWindowForTest(null);
    useModules.getState().setAll([mod("object-eraser", "Object Eraser"), mod("downloader", "Downloader")]);
    useUI.setState({ view: "object-eraser", handoff: null });
    useToastStore.setState({ toasts: [] });
  });

  it("openLibrary({ moduleId }) lands filtered with the newest file selected", async () => {
    const newest = img("n2", { createdAt: 9000, path: "/lib/Erased/n2.png", name: "n2.png" });
    svc.Query.mockResolvedValue({ items: [newest, img("n1", { createdAt: 1000 })], nextCursor: "" });
    act(() => openLibrary({ moduleId: "object-eraser" }));
    expect(useUI.getState().view).toBe("library");
    expect(useLibrary.getState().filters.moduleId).toBe("object-eraser");
    render(<LibraryView />);
    await waitFor(() => expect(lastQuery().moduleId).toBe("object-eraser"));
    const panel = await screen.findByRole("complementary", { name: "Details" });
    expect(panel.textContent).toContain("n2.png");
    expect(screen.getByRole("option", { name: "n2.png" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: /Filters/ }).textContent).toContain("Object Eraser");
  });

  it("openLibrary({ moduleId }) while the Library is open re-filters it", async () => {
    svc.Query.mockResolvedValue({ items: [out("a")], nextCursor: "" });
    render(<LibraryView />);
    await screen.findByText("a.mp3");
    svc.Query.mockResolvedValue({ items: [img("n2")], nextCursor: "" });
    act(() => openLibrary({ moduleId: "object-eraser" }));
    await screen.findByText("n2.png");
    expect(lastQuery().moduleId).toBe("object-eraser");
    expect(screen.getByRole("option", { name: "n2.png" }).getAttribute("aria-selected")).toBe("true");
  });

  it("openLibrary({ path, outputId }) selects that output and opens its details, even when the list doesn't hold it", async () => {
    svc.Query.mockResolvedValue({ items: [out("a")], nextCursor: "" });
    svc.Detail.mockImplementation((id: string) => Promise.resolve({ output: out(id), jobTitle: "", options: "", summary: "", madeFrom: [], madeInto: [], chain: [], chainAt: 0, width: 0, height: 0 }));
    act(() => openLibrary({ path: "/lib/far.png", outputId: "far" }));
    render(<LibraryView />);
    const panel = await screen.findByRole("complementary", { name: "Details" });
    expect(panel.textContent).toContain("far.png");
    await waitFor(() => expect(svc.Detail).toHaveBeenCalledWith("far"));
  });

  it("openLibrary({ path }) for a file no job made opens it by path", async () => {
    svc.Query.mockResolvedValue({ items: [], nextCursor: "" });
    act(() => openLibrary({ path: "/lib/Erased/loose.png" }));
    render(<LibraryView />);
    await screen.findByRole("complementary", { name: "Details" });
    await waitFor(() => expect(svc.Detail).toHaveBeenCalledWith("/lib/Erased/loose.png"));
  });

  it("openLibrary() with nothing just opens the Library with fresh filters", () => {
    useLibrary.getState().setFilters({ moduleId: "stems", search: "x" });
    act(() => openLibrary());
    expect(useLibrary.getState().filters).toMatchObject({ moduleId: "", search: "" });
    expect(useLibrary.getState().target).toBeNull();
  });

  describe('"Show in Library"', () => {
    it("is in every tool header and opens the Library for that tool", () => {
      render(
        <ToolHeader aria-label="Eraser header">
          <button type="button">Save it</button>
        </ToolHeader>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Show in Library" }));
      expect(useUI.getState().view).toBe("library");
      expect(useLibrary.getState().filters.moduleId).toBe("object-eraser");
      expect(useLibrary.getState().target?.moduleId).toBe("object-eraser");
    });

    it("is left out where there is no tool or no Library", () => {
      useUI.setState({ view: "settings" });
      const { unmount } = render(<ToolHeader>x</ToolHeader>);
      expect(screen.queryByRole("button", { name: "Show in Library" })).toBeNull();
      unmount();
      useUI.setState({ view: "object-eraser" });
      setCurrentWindowForTest({ kind: "tool", key: "k", view: "object-eraser" } as never);
      render(<ToolHeader>x</ToolHeader>);
      expect(screen.queryByRole("button", { name: "Show in Library" })).toBeNull();
    });

    it("single-file completion toasts offer it next to Reveal", () => {
      useUI.setState({ view: "downloader", trayOpen: false });
      useJobs.setState({
        byId: {
          j1: { id: "j1", moduleId: "object-eraser", status: JobStatus.JobDone, title: "t", inputs: [], outputs: [img("o1")], createdAt: 1 } as never,
        },
      });
      notifyDone("object-eraser", [useJobs.getState().byId.j1 as never]);
      const t = useToastStore.getState().toasts.at(-1);
      expect(t?.action?.label).toBe("Reveal");
      expect(t?.secondaryAction?.label).toBe("Show in Library");
      act(() => t?.secondaryAction?.onClick());
      expect(useUI.getState().view).toBe("library");
      expect(useLibrary.getState().filters.moduleId).toBe("object-eraser");
      expect(useLibrary.getState().target).toMatchObject({ path: "/lib/o1.png", outputId: "o1" });
    });
  });

  it("Mod+L is listed in the shortcuts overlay", async () => {
    const { GLOBAL_SHORTCUTS } = await import("@/shell/ShortcutsOverlay");
    expect(GLOBAL_SHORTCUTS.some((r) => r.combo === "Mod+L" && r.label === "Library")).toBe(true);
  });
});
