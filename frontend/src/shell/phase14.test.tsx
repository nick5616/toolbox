import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clipboardFiles = vi.hoisted(() => vi.fn());
const match = vi.hoisted(() => vi.fn());
const routed = vi.hoisted(() => vi.fn());
vi.mock("@/lib/events", () => ({ on: () => () => undefined }));
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    FilesService: { ClipboardFiles: () => clipboardFiles() },
    ModulesService: { Match: (p: string[]) => match(p) },
    LibraryService: { Reveal: vi.fn(async () => undefined), Open: vi.fn(async () => undefined) },
  };
});
vi.mock("./dropRouting", () => ({ routeFilesDropped: (d: unknown) => routed(d) }));

import { Category, JobStatus, ModuleStatus, type Descriptor, type Job } from "@/lib/api";
import { useToastStore } from "@/components/toast";
import { registerCommands, useCommandRegistry } from "@/lib/commands";
import { announceWhenDone, muteWhenDone, useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { CommandPalette } from "./CommandPalette";
import { JobTray } from "./JobTray";
import { ShortcutsOverlay, shortcutRows } from "./ShortcutsOverlay";
import { wordMatch } from "./keywords";
import { BATCH_SETTLE_MS, useJobToasts } from "./useJobToasts";
import { routePastedFiles, routePastedLinks } from "./useGlobalPaste";
import { runAddFiles, useShellShortcuts } from "./useShellShortcuts";


function mod(id: string, name: string, tagline: string, urls = false): Descriptor {
  return {
    id, name, tagline, description: "", icon: "box", category: Category.CategoryUtility, status: ModuleStatus.StatusReady,
    accepts: { extensions: null, urls, any: false }, requires: null, recommends: null, outputSubdir: "", order: 1, hidden: false, jobLess: false, maxInputs: 0, base: "", parts: null,
  };
}

function job(id: string, moduleId: string, status: JobStatus, createdAt = 1000, outputs = 1): Job {
  return {
    id, moduleId, title: id, status, progress: 0, message: "", inputs: [], optionsJson: "", errorCode: "" as Job["errorCode"], error: "", errorHint: "", attempt: 1,
    cancelRequested: false, createdAt, startedAt: 0, finishedAt: 0,
    outputs: Array.from({ length: outputs }, (_, i) => ({ id: `${id}-o${i}`, jobId: id, moduleId, path: `/out/${id}-${i}.png`, name: `${id}-${i}.png`, kind: "image" as never, sizeBytes: 1, createdAt: 1, tags: null, missing: false })),
    resultJson: "", pipelineRunId: "", pipelineStepId: "",
  };
}

const toasts = () => useToastStore.getState().toasts.filter((t) => !t.leaving);

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
  useCommandRegistry.setState({ commands: {} });
  useModules.getState().setAll([mod("downloader", "Downloader", "Save videos and audio from links", true), mod("archiver", "Web Archiver", "Save web pages", true), mod("stems", "Stem Splitter", "Split a song into vocals, drums, bass and other"), mod("exif", "Photo Metadata", "See or remove location and camera info")]);
  useUI.setState({ view: "stems", handoff: null, trayOpen: false, shortcutsOpen: false, paletteOpen: false, seenFailed: [], recentTools: [], pinned: [] });
  routed.mockReset();
  clipboardFiles.mockReset();
  match.mockReset();
});

afterEach(() => vi.useRealTimers());

describe("palette search", () => {
  it("finds tools by keyword and tagline, and shows the tagline", () => {
    useUI.setState({ paletteOpen: true });
    render(<CommandPalette />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "vocals" } });
    expect(screen.getByText("Stem Splitter")).toBeTruthy();
    expect(screen.getByText("Split a song into vocals, drums, bass and other")).toBeTruthy();
    fireEvent.change(input, { target: { value: "gps" } });
    expect(screen.getByText("Photo Metadata")).toBeTruthy();
    fireEvent.change(input, { target: { value: "youtube" } });
    expect(screen.getByText("Downloader")).toBeTruthy();
    fireEvent.change(input, { target: { value: "location" } });
    expect(screen.getByText("Photo Metadata")).toBeTruthy();
  });

  it("word match is by word prefix, not scattered letters", () => {
    expect(wordMatch("voc", "Split into vocals")).not.toBeNull();
    expect(wordMatch("svt", "Split a song into vocals")).toBeNull();
    expect(wordMatch("song vocals", "Split a song into vocals")).not.toBeNull();
  });
});

describe("paste", () => {
  it("gives links to the current view when it takes links", () => {
    useUI.setState({ view: "archiver" });
    routePastedLinks(["https://a.example"]);
    expect(useUI.getState().handoff).toMatchObject({ moduleId: "archiver", inputs: ["https://a.example"] });
    expect(toasts()).toHaveLength(0);
  });

  it("otherwise sends them to the Downloader with an Undo that goes back", () => {
    routePastedLinks(["https://a.example"]);
    expect(useUI.getState().view).toBe("downloader");
    expect(useUI.getState().handoff?.moduleId).toBe("downloader");
    const t = toasts()[0]!;
    expect(t.action?.label).toBe("Undo");
    t.action!.onClick();
    expect(useUI.getState().view).toBe("stems");
    expect(useUI.getState().handoff).toBeNull();
  });

  it("routes pasted files like a drop on the current tool", async () => {
    clipboardFiles.mockResolvedValue(["/x/a.png"]);
    match.mockResolvedValue({ matches: [], unmatched: [] });
    await routePastedFiles();
    expect(routed).toHaveBeenCalledWith(expect.objectContaining({ paths: ["/x/a.png"], targetId: "", window: "" }));
  });

  it("does nothing when the clipboard holds no files", async () => {
    clipboardFiles.mockResolvedValue([]);
    await routePastedFiles();
    expect(routed).not.toHaveBeenCalled();
  });
});

describe("Mod+O and the shortcuts overlay", () => {
  it("Mod+O runs the tool's tool.addFiles command, and does nothing without one", () => {
    renderHook(() => useShellShortcuts());
    const run = vi.fn();
    expect(runAddFiles()).toBe(false);
    registerCommands([{ id: "tool.addFiles", title: "Add files…", section: "Actions", shortcut: "Mod+O", run }]);
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("? toggles the overlay (not inside inputs)", () => {
    renderHook(() => useShellShortcuts());
    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    expect(useUI.getState().shortcutsOpen).toBe(true);
    useUI.setState({ shortcutsOpen: false });
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "?", shiftKey: true });
    expect(useUI.getState().shortcutsOpen).toBe(false);
    input.remove();
  });

  it("lists global and current-tool shortcuts from the registry", () => {
    registerCommands([
      { id: "shell.toggle-tray", title: "Toggle job tray", section: "Actions", shortcut: "Mod+J", run: () => undefined },
      { id: "trimmer.split", title: "Split at playhead", section: "Actions", shortcut: "S", run: () => undefined },
      { id: "tool.addFiles", title: "Add files…", section: "Actions", shortcut: "Mod+O", run: () => undefined },
    ]);
    const rows = shortcutRows(useCommandRegistry.getState().commands);
    expect(rows.global.map((r) => r.label)).toContain("Toggle job tray");
    expect(rows.global.map((r) => r.combo)).toContain("Mod+O");
    expect(rows.tool.map((r) => r.label)).toEqual(["Split at playhead"]);
    useUI.setState({ shortcutsOpen: true });
    render(<ShortcutsOverlay />);
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUI.getState().shortcutsOpen).toBe(false);
  });
});

describe("completion toasts", () => {
  it("merges a batch into one toast with Send to…", () => {
    vi.useFakeTimers();
    useUI.setState({ view: "library" });
    renderHook(() => useJobToasts());
    act(() => {
      for (let i = 0; i < 3; i++) useJobs.getState().upsert(job(`j${i}`, "stems", JobStatus.JobRunning, 1000 + i));
    });
    act(() => {
      for (let i = 0; i < 3; i++) useJobs.getState().upsert(job(`j${i}`, "stems", JobStatus.JobDone, 1000 + i));
    });
    expect(toasts()).toHaveLength(0);
    act(() => void vi.advanceTimersByTime(BATCH_SETTLE_MS + 10));
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.title).toBe("Stem Splitter: 3 files saved");
    expect(toasts()[0]!.action?.label).toBe("Send to…");
  });

  it("one finished job still toasts alone with Reveal", () => {
    vi.useFakeTimers();
    useUI.setState({ view: "library" });
    renderHook(() => useJobToasts());
    act(() => void useJobs.getState().upsert(job("solo", "stems", JobStatus.JobRunning)));
    act(() => void useJobs.getState().upsert(job("solo", "stems", JobStatus.JobDone)));
    act(() => void vi.advanceTimersByTime(BATCH_SETTLE_MS + 10));
    expect(toasts()[0]!.title).toBe("Saved solo-0.png");
    expect(toasts()[0]!.action?.label).toBe("Reveal");
  });

  it("no completion toast for Focus jobs (the pill and focus toasts cover them)", () => {
    vi.useFakeTimers();
    useUI.setState({ view: "library" });
    renderHook(() => useJobToasts());
    act(() => void useJobs.getState().upsert(job("f", "focus", JobStatus.JobRunning, 1000, 0)));
    act(() => void useJobs.getState().upsert(job("f", "focus", JobStatus.JobDone, 1000, 0)));
    act(() => void vi.advanceTimersByTime(BATCH_SETTLE_MS + 10));
    expect(toasts()).toHaveLength(0);
  });

  it("no toast when that tool is on screen", () => {
    vi.useFakeTimers();
    useUI.setState({ view: "stems" });
    renderHook(() => useJobToasts());
    act(() => void useJobs.getState().upsert(job("j", "stems", JobStatus.JobRunning)));
    act(() => void useJobs.getState().upsert(job("j", "stems", JobStatus.JobDone)));
    act(() => void vi.advanceTimersByTime(BATCH_SETTLE_MS + 10));
    expect(toasts()).toHaveLength(0);
  });

  it("toasts with Reveal while the tool is on screen when the job was announced", () => {
    vi.useFakeTimers();
    useUI.setState({ view: "stems" });
    renderHook(() => useJobToasts());
    act(() => void useJobs.getState().upsert(job("a", "stems", JobStatus.JobRunning)));
    announceWhenDone("a");
    act(() => void useJobs.getState().upsert(job("a", "stems", JobStatus.JobDone)));
    act(() => void vi.advanceTimersByTime(BATCH_SETTLE_MS + 10));
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.action?.label).toBe("Reveal");
  });

  it("no toast for a job another tool muted (it shows the result itself)", () => {
    vi.useFakeTimers();
    useUI.setState({ view: "post-builder" });
    renderHook(() => useJobToasts());
    act(() => void useJobs.getState().upsert(job("m", "stems", JobStatus.JobRunning)));
    muteWhenDone("m");
    act(() => void useJobs.getState().upsert(job("m", "stems", JobStatus.JobDone)));
    act(() => void vi.advanceTimersByTime(BATCH_SETTLE_MS + 10));
    expect(toasts()).toHaveLength(0);
  });
});

describe("job tray failures", () => {
  it("counts new failures until the tray has been opened, then goes neutral", () => {
    useJobs.getState().setAll([job("f1", "stems", JobStatus.JobFailed), job("f2", "stems", JobStatus.JobFailed)]);
    render(<JobTray />);
    expect(screen.getByText("2 new failures")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Toggle job tray" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle job tray" }));
    expect(screen.queryByText(/new failure/)).toBeNull();
    expect(screen.getByText("2 failed")).toBeTruthy();
    act(() => void useJobs.getState().upsert(job("f3", "stems", JobStatus.JobFailed)));
    expect(screen.getByText("1 new failure")).toBeTruthy();
  });

  it("ignores finished quiet jobs (background indexing) in the counts", () => {
    useUI.setState({ seenFailed: [] });
    useJobs.getState().setAll([{ ...job("q1", "media-index", JobStatus.JobFailed), quiet: true }, { ...job("q2", "media-index", JobStatus.JobDone), quiet: true }, job("d1", "stems", JobStatus.JobDone)]);
    render(<JobTray />);
    expect(screen.queryByText(/new failure/)).toBeNull();
    expect(screen.queryByText(/failed/)).toBeNull();
    expect(screen.getByText("1 done")).toBeTruthy();
  });
});
