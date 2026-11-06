import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ open: vi.fn(async (_id: string) => undefined), retry: vi.fn(async (_id: string) => undefined) }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    FilesService: { Stat: async (p: string[]) => p.map((path) => ({ path, exists: true, isDir: false, sizeBytes: 1 })), Pick: async () => [] },
    LibraryService: { Reveal: async () => undefined, RevealPath: async () => undefined, Open: (id: string) => h.open(id) },
    SettingsService: { ModuleState: vi.fn().mockResolvedValue(""), SetModuleState: vi.fn().mockResolvedValue(undefined) },
  };
});

import { JobStatus, ModuleStatus, type Descriptor } from "@/lib/api";
import { PATHS_MIME } from "@/lib/fileDrag";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { usePipelines } from "@/state/pipelines";
import { FailedJobs, useDismissedJobs } from "./FailedJobs";
import { formatResultDate } from "./format";
import { ResultRow } from "./ResultRow";

function mod(id: string, name: string, exts: string[]): Descriptor {
  return { id, name, tagline: "", description: "", icon: "box", status: ModuleStatus.StatusReady, accepts: { extensions: exts, urls: false, any: false }, requires: null, recommends: null, maxInputs: 0, hidden: false, order: 1 } as unknown as Descriptor;
}

beforeEach(() => {
  h.open.mockClear();
  h.retry.mockClear();
  useModules.getState().setAll([mod("converter", "Converter", [".png"]), mod("bg-remover", "Background Remover", [".png"])]);
  usePipelines.setState({
    entries: [
      { pipeline: { id: "p1", name: "Tidy photos" }, check: { accepts: { any: false, extensions: [".png"], urls: false } } },
      { pipeline: { id: "p2", name: "Audio only" }, check: { accepts: { any: false, extensions: [".mp3"], urls: false } } },
    ],
    runSheet: null,
  } as never);
  useJobs.getState().setAll([]);
  useDismissedJobs.getState().reset();
});

describe("ResultRow", () => {
  it("shows the name, not the path, with one size and date format", () => {
    render(<ResultRow path="/deep/folder/shot.png" outputId="o1" sizeBytes={2048} at={Date.now() - 5 * 60_000} moduleId="converter" />);
    const name = screen.getByText("shot.png");
    expect(name.getAttribute("data-tip")).toBe("/deep/folder/shot.png");
    expect(screen.queryByText("/deep/folder/shot.png")).toBeNull();
    expect(screen.getByText("2.0 KiB")).toBeTruthy();
    expect(screen.getByText("5m ago")).toBeTruthy();
  });

  it("is draggable and carries the path", () => {
    render(<ResultRow path="/a/shot.png" outputId="o1" moduleId="converter" />);
    const row = screen.getByRole("group", { name: "shot.png" });
    expect(row.getAttribute("draggable")).toBe("true");
    const data = new Map<string, string>();
    const dataTransfer = { setData: (k: string, v: string) => void data.set(k, v), types: [] as string[], effectAllowed: "" };
    fireEvent.dragStart(row, { dataTransfer });
    expect(JSON.parse(data.get(PATHS_MIME) ?? "null")).toEqual(["/a/shot.png"]);
    expect(data.get("text/uri-list")).toContain("shot.png");
  });

  it("opens the file on double-click and on Enter", async () => {
    render(<ResultRow path="/a/shot.png" outputId="o1" moduleId="converter" />);
    const row = screen.getByRole("group", { name: "shot.png" });
    fireEvent.doubleClick(row);
    expect(h.open).toHaveBeenCalledWith("o1");
    h.open.mockClear();
    await act(async () => row.focus());
    await userEvent.keyboard("{Enter}");
    expect(h.open).toHaveBeenCalledWith("o1");
  });

  it("does not open or drag a missing file", () => {
    render(<ResultRow path="/a/gone.png" outputId="o1" missing moduleId="converter" />);
    const row = screen.getByRole("group", { name: "gone.png" });
    expect(row.getAttribute("draggable")).toBe("false");
    fireEvent.doubleClick(row);
    expect(h.open).not.toHaveBeenCalled();
    expect(screen.getByText("MISSING")).toBeTruthy();
  });

  it("keeps Send to visible, and Reveal and Open reachable by keyboard", async () => {
    render(<ResultRow path="/a/shot.png" outputId="o1" moduleId="converter" />);
    expect(screen.getByRole("button", { name: "Send to…" })).toBeTruthy();
    // Hidden by opacity only: still in the tab order.
    const open = screen.getByRole("button", { name: "Open" });
    await act(async () => open.focus());
    expect(document.activeElement).toBe(open);
    expect(open.closest("[data-result-row]")).toBeTruthy();
  });

  it("lists tools, new windows and the pipelines that take the file", async () => {
    render(<ResultRow path="/a/shot.png" outputId="o1" moduleId="converter" />);
    await userEvent.click(screen.getByRole("button", { name: "Send to…" }));
    expect(await screen.findByRole("menuitem", { name: "Background Remover" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Background Remover (new window)" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Pipeline: Tidy photos" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Pipeline: Audio only" })).toBeNull();
    await userEvent.click(screen.getByRole("menuitem", { name: "Pipeline: Tidy photos" }));
    expect(usePipelines.getState().runSheet).toEqual(expect.objectContaining({ pipelineId: "p1", inputs: ["/a/shot.png"] }));
  });
});

describe("formatResultDate", () => {
  it("is relative under a day, then a short date", () => {
    const now = new Date(2026, 10, 4, 12, 0, 0).getTime();
    expect(formatResultDate(now - 10_000, now)).toBe("just now");
    expect(formatResultDate(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatResultDate(new Date(2026, 9, 12, 9, 0).getTime(), now)).toBe("Oct 12");
    expect(formatResultDate(new Date(2025, 9, 12, 9, 0).getTime(), now)).toBe("Oct 12, 2025");
  });
});

describe("FailedJobs", () => {
  const failed = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    moduleId: "converter",
    status: JobStatus.JobFailed,
    title: `job ${id}`,
    inputs: ["/a.png"],
    outputs: [],
    error: "Disk is full",
    errorHint: "Free some space",
    createdAt: Date.now(),
    finishedAt: Date.now() + 1000,
    ...over,
  });

  it("keeps this session's failed and cancelled jobs until dismissed", async () => {
    useJobs.getState().setAll([failed("f1"), failed("c1", { status: JobStatus.JobCancelled }), failed("old", { finishedAt: 5 }), failed("other", { moduleId: "stems" })] as never);
    render(<FailedJobs moduleId="converter" />);
    expect(screen.getByText("job f1")).toBeTruthy();
    expect(screen.getByText("Disk is full")).toBeTruthy();
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.queryByText("job old")).toBeNull();
    expect(screen.queryByText("job other")).toBeNull();
    // Still there after the store updates for something else.
    act(() => useJobs.getState().setAll([failed("f1"), failed("c1", { status: JobStatus.JobCancelled })] as never));
    expect(screen.getByText("job f1")).toBeTruthy();
    await userEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]!);
    expect(screen.queryByText("job f1")).toBeNull();
    expect(screen.getByText("job c1")).toBeTruthy();
  });

  it("offers Retry", () => {
    useJobs.setState({ retry: (id: string) => h.retry(id) } as never);
    useJobs.getState().setAll([failed("f1")] as never);
    render(<FailedJobs moduleId="converter" />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(h.retry).toHaveBeenCalledWith("f1");
  });

  it("renders nothing without failures", () => {
    const { container } = render(<FailedJobs moduleId="converter" />);
    expect(container.firstChild).toBeNull();
  });
});
