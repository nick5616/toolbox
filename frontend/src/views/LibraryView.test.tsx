import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    LibraryService: {
      Recent: vi.fn().mockResolvedValue({ items: [], nextCursor: "" }),
      Reveal: vi.fn().mockResolvedValue(undefined),
      Open: vi.fn().mockResolvedValue(undefined),
      Remove: vi.fn().mockResolvedValue(undefined),
      OpenLibraryFolder: vi.fn().mockResolvedValue(undefined),
      RevealPath: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { OutputKind, type Output, type OutputQuery } from "@/lib/api";
import { useToastStore } from "@/components/toast";
import { PATHS_MIME } from "@/lib/fileDrag";
import { revealLabel } from "@/lib/platform";
import { useLibrary } from "@/state/library";
import { LibraryView } from "./LibraryView";

function out(id: string, over: Partial<Output> = {}): Output {
  return {
    id,
    jobId: "j",
    moduleId: "downloader",
    path: `/lib/${id}.mp3`,
    name: `${id}.mp3`,
    kind: OutputKind.KindAudio,
    sizeBytes: 2048,
    createdAt: Date.now(),
    missing: false,
    tags: [],
    ...over,
  } as Output;
}

describe("LibraryView", () => {
  let refresh: Mock<(q?: Partial<OutputQuery>) => Promise<void>>;
  let remove: Mock<(id: string) => Promise<void>>;

  beforeEach(() => {
    refresh = vi.fn<(q?: Partial<OutputQuery>) => Promise<void>>().mockResolvedValue(undefined);
    remove = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
    useLibrary.setState({ refresh, remove });
    useLibrary.getState().setPage([out("a"), out("b", { missing: true })], "");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders rows and flags missing files", () => {
    render(<LibraryView />);
    expect(screen.getByText("a.mp3")).toBeTruthy();
    expect(screen.getByText("MISSING")).toBeTruthy();
    const reveals = screen.getAllByRole("button", { name: revealLabel });
    expect((reveals[0] as HTMLButtonElement).disabled).toBe(false);
    expect((reveals[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it("debounces search into refresh", () => {
    vi.useFakeTimers();
    render(<LibraryView />);
    fireEvent.change(screen.getByLabelText("Search outputs"), { target: { value: "cat" } });
    expect(refresh).not.toHaveBeenCalledWith({ search: "cat", moduleId: "" });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(refresh).toHaveBeenCalledWith({ search: "cat", moduleId: "" });
  });

  it("forgets with an Undo window, then removes through the store", () => {
    vi.useFakeTimers();
    render(<LibraryView />);
    fireEvent.click(screen.getAllByRole("button", { name: "Forget" })[0] as HTMLElement);
    expect(screen.queryByText("a.mp3")).toBeNull();
    expect(remove).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(6100);
    });
    expect(remove).toHaveBeenCalledWith("a");
  });

  it("Undo brings a forgotten entry back without removing it", () => {
    vi.useFakeTimers();
    render(<LibraryView />);
    fireEvent.click(screen.getAllByRole("button", { name: "Forget" })[0] as HTMLElement);
    const t = useToastStore.getState().toasts.at(-1);
    expect(t?.action?.label).toBe("Undo");
    act(() => t?.action?.onClick());
    act(() => {
      vi.advanceTimersByTime(7000);
    });
    expect(screen.getByText("a.mp3")).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();
  });

  it("filters by type chips", () => {
    useLibrary.getState().setPage([out("a"), out("v", { kind: OutputKind.KindVideo, name: "v.mp4" })], "");
    render(<LibraryView />);
    fireEvent.click(screen.getByRole("radio", { name: "Video" }));
    expect(screen.queryByText("a.mp3")).toBeNull();
    expect(screen.getByText("v.mp4")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Other" }));
    expect(screen.getByText("No files of this type.")).toBeTruthy();
  });

  describe("multi-select", () => {
    beforeEach(() => {
      useLibrary.getState().setPage([out("a"), out("b"), out("c")], "");
    });
    const row = (n: string) => screen.getByText(`${n}.mp3`).closest("li") as HTMLElement;
    const sel = () => screen.getAllByRole("option").filter((o) => o.getAttribute("aria-selected") === "true").length;

    it("click, Mod-click and Shift-click build a selection with a bulk bar", () => {
      render(<LibraryView />);
      fireEvent.click(row("a"));
      expect(sel()).toBe(1);
      expect(screen.queryByRole("toolbar", { name: "Selected files" })).toBeNull();
      fireEvent.click(row("c"), { ctrlKey: true });
      expect(sel()).toBe(2);
      expect(screen.getByText("2 selected")).toBeTruthy();
      fireEvent.click(row("a"));
      fireEvent.click(row("c"), { shiftKey: true });
      expect(sel()).toBe(3);
    });

    it("Mod+A selects everything and bulk Forget hides them all", () => {
      vi.useFakeTimers();
      render(<LibraryView />);
      fireEvent.keyDown(window, { key: "a", ctrlKey: true });
      fireEvent.keyDown(window, { key: "a", metaKey: true });
      expect(sel()).toBe(3);
      const bar = screen.getByRole("toolbar", { name: "Selected files" });
      fireEvent.click(within(bar).getByRole("button", { name: "Forget" }));
      expect(screen.queryAllByRole("option")).toHaveLength(0);
      act(() => {
        vi.advanceTimersByTime(6100);
      });
      expect(remove).toHaveBeenCalledTimes(3);
    });

    it("dragging a selected row carries every selected file", () => {
      render(<LibraryView />);
      fireEvent.click(row("a"));
      fireEvent.click(row("b"), { ctrlKey: true });
      const data: Record<string, string> = {};
      const dataTransfer = { setData: (k: string, v: string) => (data[k] = v), types: [] as string[], effectAllowed: "" };
      fireEvent.dragStart(row("a"), { dataTransfer });
      expect(JSON.parse(data[PATHS_MIME] ?? "[]")).toEqual(["/lib/a.mp3", "/lib/b.mp3"]);
      fireEvent.dragStart(row("c"), { dataTransfer });
      expect(JSON.parse(data[PATHS_MIME] ?? "[]")).toEqual(["/lib/c.mp3"]);
    });
  });

  it("keeps filters in a click-in with a summary", () => {
    render(<LibraryView />);
    const launcher = screen.getByRole("button", { name: /Filters/ });
    expect(launcher.textContent).toContain("All tools");
    fireEvent.click(launcher);
    expect(screen.getByLabelText("Filter by tool")).toBeTruthy();
  });
});
