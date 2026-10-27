import { act, fireEvent, render, screen } from "@testing-library/react";
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

  it("removes through the store", () => {
    render(<LibraryView />);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove from library" })[0] as HTMLElement);
    expect(remove).toHaveBeenCalledWith("a");
  });
});
