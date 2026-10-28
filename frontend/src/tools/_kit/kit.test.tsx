import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stat = vi.fn();
const pick = vi.fn();
const installEngine = vi.fn();
const updateExiftool = vi.fn();
const writeText = vi.fn().mockResolvedValue(undefined);
const installUpscaler = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    FilesService: { Stat: (p: string[]) => stat(p), Pick: (m: string) => pick(m) },
    DepsService: { InstallAudioEngine: () => installEngine(), UpdateExiftool: () => updateExiftool(), InstallUpscaler: () => installUpscaler() },
    SettingsService: { ModuleState: vi.fn().mockResolvedValue(""), SetModuleState: vi.fn().mockResolvedValue(undefined) },
  };
});

import { DepState, ModuleStatus, type DepStatus, type Descriptor, type FileInfo } from "@/lib/api";
import { useToastStore } from "@/components/toast";
import { useDeps } from "@/state/deps";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { DepsGate, useDepsGate } from "./DepsGate";
import { ResultTable, toCsv, type ResultColumn } from "./ResultTable";
import { useFileInputs } from "./useFileInputs";

function mod(over: Partial<Descriptor> = {}): Descriptor {
  return {
    id: "stems",
    name: "Stems",
    tagline: "t",
    description: "",
    icon: "box",
    status: ModuleStatus.StatusReady,
    accepts: { extensions: [".mp3", ".WAV"], urls: false },
    requires: ["audio-engine"],
    recommends: null,
    maxInputs: 3,
    ...over,
  } as Descriptor;
}

function fi(path: string, over: Partial<FileInfo> = {}): FileInfo {
  return { path, name: path, sizeBytes: 10, exists: true, isDir: false, kind: "audio", ...over } as FileInfo;
}

function dep(id: string, state: DepState): DepStatus {
  return { id, name: id, purpose: "", state, version: "", path: "", source: "", required: true, requiredBy: [], recommendedBy: null, installHint: "brew install x", error: "" } as unknown as DepStatus;
}

beforeEach(() => {
  stat.mockReset().mockImplementation(async (ps: string[]) => ps.map((p) => fi(p)));
  pick.mockReset();
  installEngine.mockReset();
  useModules.getState().setAll([mod()]);
  useUI.setState({ handoff: null });
  useDeps.getState().setAll([]);
  useJobs.getState().setAll([]);
  Object.assign(navigator, { clipboard: { writeText } });
  useToastStore.setState({ toasts: [] });
});

describe("useFileInputs", () => {
  it("adds, dedupes and filters unsupported extensions", async () => {
    const { result } = renderHook(() => useFileInputs("stems"));
    await act(() => result.current.add(["/a.mp3", "/b.txt", "/a.mp3", "/c.wav"]));
    expect(result.current.files.map((f) => f.path)).toEqual(["/a.mp3", "/c.wav"]);
    expect(stat).toHaveBeenCalledWith(["/a.mp3", "/c.wav"]);
    expect(useToastStore.getState().toasts.map((t) => t.title)).toContain("Skipped 1 unsupported file");
    await act(() => result.current.add(["/a.mp3"]));
    expect(result.current.files).toHaveLength(2);
  });

  it("drops missing and directory entries", async () => {
    stat.mockResolvedValue([fi("/a.mp3", { exists: false }), fi("/b.mp3", { isDir: true }), fi("/c.mp3")]);
    const { result } = renderHook(() => useFileInputs("stems"));
    await act(() => result.current.add(["/a.mp3", "/b.mp3", "/c.mp3"]));
    expect(result.current.files.map((f) => f.path)).toEqual(["/c.mp3"]);
  });

  it("enforces maxInputs", async () => {
    const { result } = renderHook(() => useFileInputs("stems"));
    await act(() => result.current.add(["/1.mp3", "/2.mp3", "/3.mp3", "/4.mp3"]));
    expect(result.current.files).toHaveLength(3);
    expect(useToastStore.getState().toasts.map((t) => t.title)).toContain("At most 3 files at a time");
  });

  it("takes a handoff on mount and on change, and removes/clears", async () => {
    useUI.setState({ handoff: { moduleId: "stems", inputs: ["/h.mp3"] } });
    const { result } = renderHook(() => useFileInputs("stems"));
    await waitFor(() => expect(result.current.files).toHaveLength(1));
    expect(useUI.getState().handoff).toBeNull();
    act(() => useUI.getState().handOff({ moduleId: "stems", inputs: ["/i.mp3"] }));
    await waitFor(() => expect(result.current.files).toHaveLength(2));
    act(() => result.current.remove("/h.mp3"));
    expect(result.current.files.map((f) => f.path)).toEqual(["/i.mp3"]);
    act(() => result.current.clear());
    expect(result.current.files).toEqual([]);
  });

  it("pick adds the chosen paths", async () => {
    pick.mockResolvedValue(["/p.mp3"]);
    const { result } = renderHook(() => useFileInputs("stems"));
    await act(() => result.current.pick());
    expect(pick).toHaveBeenCalledWith("stems");
    expect(result.current.files.map((f) => f.path)).toEqual(["/p.mp3"]);
  });
});

describe("DepsGate", () => {
  it("does not block while deps are not loaded", () => {
    const { result } = renderHook(() => useDepsGate("stems"));
    expect(result.current.blocked).toBe(false);
    const { container } = render(<DepsGate moduleId="stems" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows install for a missing engine and queues the job", async () => {
    useDeps.getState().setAll([dep("audio-engine", DepState.DepMissing)]);
    installEngine.mockResolvedValue({ id: "j1", moduleId: "system-audio-engine", status: "queued", inputs: null, outputs: null });
    const { result } = renderHook(() => useDepsGate("stems"));
    expect(result.current).toEqual({ blocked: true, reason: "The AI engine isn't installed" });
    render(<DepsGate moduleId="stems" />);
    expect(screen.getByText("The AI engine isn't installed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Install AI engine/ }));
    await waitFor(() => expect(installEngine).toHaveBeenCalled());
  });

  it("shows progress while the install job is active", () => {
    useDeps.getState().setAll([dep("audio-engine", DepState.DepMissing)]);
    useJobs.getState().setAll([
      { id: "j1", moduleId: "system-audio-engine", status: "running", message: "Downloading Python", inputs: null, outputs: null, progress: 0.2 } as never,
    ]);
    render(<DepsGate moduleId="stems" />);
    expect(screen.getByText("Downloading Python")).toBeTruthy();
  });

  it("shows an update banner when outdated", () => {
    useDeps.getState().setAll([dep("audio-engine", DepState.DepOutdated)]);
    render(<DepsGate moduleId="stems" />);
    expect(screen.getByText("The AI engine needs an update")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
  });

  it("offers to install a missing ExifTool", async () => {
    useModules.getState().setAll([mod({ id: "exif", requires: ["exiftool"] })]);
    useDeps.getState().setAll([dep("exiftool", DepState.DepMissing)]);
    updateExiftool.mockReset().mockResolvedValue({ id: "j1", moduleId: "system-exiftool-update", status: "queued" });
    render(<DepsGate moduleId="exif" />);
    expect(screen.getByText("ExifTool isn't installed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install ExifTool" }));
    await waitFor(() => expect(updateExiftool).toHaveBeenCalledTimes(1));
  });

  it("is open when the engine is ok", () => {
    useDeps.getState().setAll([dep("audio-engine", DepState.DepOK)]);
    const { result } = renderHook(() => useDepsGate("stems"));
    expect(result.current.blocked).toBe(false);
  });

  it("shows an ffmpeg hint", () => {
    useModules.getState().setAll([mod({ requires: ["ffmpeg", "ffprobe"] })]);
    useDeps.getState().setAll([dep("ffmpeg", DepState.DepMissing), dep("ffprobe", DepState.DepMissing)]);
    render(<DepsGate moduleId="stems" />);
    expect(screen.getByText("ffmpeg is required")).toBeTruthy();
    expect(screen.getByText("brew install x")).toBeTruthy();
  });
});

interface Row {
  name: string;
  n: number;
}
const cols: ResultColumn<Row>[] = [
  { key: "name", header: "Name", render: (r) => r.name, text: (r) => r.name },
  { key: "n", header: "N", render: (r) => String(r.n), text: (r) => String(r.n), align: "right", mono: true },
];

describe("toCsv", () => {
  it("quotes commas, quotes and newlines (RFC 4180)", () => {
    const csv = toCsv([{ name: 'a,"b"', n: 1 }, { name: "x\ny", n: 2 }, { name: "plain", n: 3 }], cols);
    expect(csv).toBe('Name,N\r\n"a,""b""",1\r\n"x\ny",2\r\nplain,3');
  });
  it("returns just the header for no rows", () => {
    expect(toCsv([], cols)).toBe("Name,N");
  });
});

describe("ResultTable", () => {
  it("copies the CSV to the clipboard", async () => {
    render(<ResultTable rows={[{ name: "a", n: 1 }]} columns={cols} rowKey={(r) => r.name} label="results" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy CSV" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Name,N\r\na,1"));
  });
  it("copies a row", async () => {
    render(<ResultTable rows={[{ name: "a", n: 1 }]} columns={cols} rowKey={(r) => r.name} label="results" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy row" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("a\t1"));
  });
});

describe("DepsGate upscaler", () => {
  it("offers to install the upscaler engine", async () => {

    const spy = installUpscaler;
    spy.mockResolvedValue({ id: "j9", moduleId: "system-upscaler-install", status: "queued", inputs: null, outputs: null });
    useModules.getState().setAll([mod({ id: "upscaler", requires: ["upscayl"] })]);
    useDeps.getState().setAll([dep("upscayl", DepState.DepMissing)]);
    const { result } = renderHook(() => useDepsGate("upscaler"));
    expect(result.current.blocked).toBe(true);
    render(<DepsGate moduleId="upscaler" />);
    fireEvent.click(screen.getByRole("button", { name: "Install upscaler" }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });
});
