import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  probe: vi.fn(),
  prepare: vi.fn(),
  sources: vi.fn(),
  pickWith: vi.fn(),
  drag: vi.fn(),
  library: vi.fn(),
}));

vi.mock("@/blocks/library-picker", async (orig) => {
  const actual = await orig<typeof import("@/blocks/library-picker")>();
  return { ...actual, pickFromLibrary: (...a: unknown[]) => h.library(...a) };
});

vi.mock("@/blocks/sources/sourceDrag", async (orig) => {
  const actual = await orig<typeof import("@/blocks/sources/sourceDrag")>();
  return { ...actual, startSourceDrag: (...a: unknown[]) => h.drag(...a) };
});

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    EditStudioService: {
      Probe: (...a: unknown[]) => h.probe(...a),
      Prepare: (...a: unknown[]) => h.prepare(...a),
      Sources: (...a: unknown[]) => h.sources(...a),
      Mattes: async () => [],
    },
    MediaService: { Filmstrip: async () => "/media/t/strip.jpg", URLFor: async () => "/media/t/x", Waveform: async () => [] },
    FilesService: { PickWith: (...a: unknown[]) => h.pickWith(...a), ImageThumb: async () => "data:image/jpeg;base64,AA==" },
  };
});

import { JobStatus, type EditSourceState, type Job } from "@/lib/api";
import { PATHS_MIME } from "@/lib/fileDrag";
import { useJobs } from "@/state/jobs";
import { emptyEditProject, type NormalProject } from "@/viz/edit/defaults";
import { useEditStudio } from "@/editor/store";
import { SourcesPanel } from "./SourcesPanel";
import { useSelectedSources, useSourceSelection } from "./selection";

const st = (path: string, over: Partial<Omit<EditSourceState, "info">> & { info?: Partial<EditSourceState["info"]> } = {}): EditSourceState => {
  const { info, ...rest } = over;
  const image = path.endsWith(".jpg");
  return {
    path,
    info: { path, kind: image ? "image" : "video", durationMs: image ? 0 : 12_000, width: 1920, height: 1080, fps: 30, rotation: 0, hasAudio: false, takenAt: 0, error: "", ...info } as EditSourceState["info"],
    preview: image ? null : { stream: "/s", index: "/i", width: 540, height: 960, fps: 30, frames: 360 },
    image: image ? "/img.png" : "",
    shots: null,
    preparing: false,
    error: "",
    ...rest,
  };
};

function open(paths: string[], states: EditSourceState[] = []): void {
  const doc = emptyEditProject("9:16", 30, 1);
  doc.song = { path: "/song.mp3", startMs: 0, endMs: 20_000, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 };
  doc.sources = paths.map((path) => ({ path, tags: [] }));
  useEditStudio.getState().open("p1", "Edit", doc as NormalProject);
  useEditStudio.getState().setSources(states);
}
const project = () => useEditStudio.getState().history!.present;

function Probe() {
  const sel = useSelectedSources();
  return <output data-testid="sel">{sel.join(",")}</output>;
}

beforeEach(() => {
  Object.values(h).forEach((f) => f.mockReset());
  h.sources.mockResolvedValue([]);
  h.prepare.mockResolvedValue({ id: "job1", moduleId: "edit-studio", status: JobStatus.JobRunning, progress: 0.25 } as unknown as Job);
  useEditStudio.getState().close();
  useSourceSelection.getState().clear();
});
afterEach(cleanup);

describe("SourcesPanel", () => {
  it("shows the empty state with a drop zone", () => {
    open([]);
    render(<SourcesPanel />);
    expect(screen.getByText("Drop clips and photos here")).toBeTruthy();
  });

  it("takes files dragged in from another tool (PATHS_MIME) as new sources", async () => {
    open(["/c/a.mp4"], [st("/c/a.mp4")]);
    h.probe.mockResolvedValue([{ path: "/c/b.mp4", kind: "video", durationMs: 4000, error: "" }]);
    const { container } = render(<SourcesPanel />);
    const data: Record<string, string> = { [PATHS_MIME]: JSON.stringify(["/c/a.mp4", "/c/b.mp4"]) };
    fireEvent.drop(container.firstElementChild!, { dataTransfer: { types: [PATHS_MIME], getData: (k: string) => data[k] ?? "" } });
    await waitFor(() => expect(h.prepare).toHaveBeenCalledWith("p1", ["/c/b.mp4"], 30));
    expect(project().sources.map((s) => s.path)).toEqual(["/c/a.mp4", "/c/b.mp4"]);
  });

  it("ignores a drag that carries no in-app files", () => {
    open(["/c/a.mp4"], [st("/c/a.mp4")]);
    const { container } = render(<SourcesPanel />);
    fireEvent.drop(container.firstElementChild!, { dataTransfer: { types: ["Files"], getData: () => "" } });
    expect(h.probe).not.toHaveBeenCalled();
  });

  it("shows each source's status", () => {
    open(["/c/a.mp4", "/c/gone.mp4", "/c/busy.mp4", "/c/bad.mp4", "/c/p.jpg"], [
      st("/c/a.mp4"),
      st("/c/gone.mp4", { info: { error: "no such file" } }),
      st("/c/busy.mp4", { preparing: true, preview: null }),
      st("/c/bad.mp4", { error: "decode failed", preview: null }),
      st("/c/p.jpg"),
    ]);
    render(<SourcesPanel />);
    const tile = (name: string) => screen.getByRole("button", { name });
    expect(within(tile("a.mp4")).getByText("Ready")).toBeTruthy();
    expect(within(tile("a.mp4")).getByText("0:12")).toBeTruthy();
    expect(within(tile("gone.mp4")).getByText("Missing")).toBeTruthy();
    expect(within(tile("busy.mp4")).getByText(/Preparing/)).toBeTruthy();
    expect(within(tile("bad.mp4")).getByText("Error")).toBeTruthy();
    expect(within(tile("p.jpg")).getByText("Ready")).toBeTruthy();
  });

  it("adds picked files: Probe, append deduplicated, Prepare at the project fps", async () => {
    open(["/c/a.mp4"], [st("/c/a.mp4")]);
    h.pickWith.mockResolvedValue(["/c/a.mp4", "/c/b.mp4", "/c/song.mp3"]);
    h.probe.mockResolvedValue([
      { path: "/c/b.mp4", kind: "video", durationMs: 4000, error: "" },
      { path: "/c/song.mp3", kind: "audio", durationMs: 100_000, error: "" },
    ]);
    render(<SourcesPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(h.prepare).toHaveBeenCalled());
    expect(h.probe).toHaveBeenCalledWith(["/c/b.mp4", "/c/song.mp3"]);
    expect(project().sources.map((s) => s.path)).toEqual(["/c/a.mp4", "/c/b.mp4"]);
    expect(h.prepare).toHaveBeenCalledWith("p1", ["/c/b.mp4"], 30);
    expect(useEditStudio.getState().jobs.prepare).toBe("job1");
  });

  it("Add from Library takes the same path as the native pick", async () => {
    open(["/c/a.mp4"], [st("/c/a.mp4")]);
    h.library.mockResolvedValue(["/c/a.mp4", "/c/b.mp4"]);
    h.probe.mockResolvedValue([{ path: "/c/b.mp4", kind: "video", durationMs: 4000, error: "" }]);
    render(<SourcesPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Add from Library" }));
    await waitFor(() => expect(h.prepare).toHaveBeenCalled());
    expect(h.library).toHaveBeenCalledWith(expect.objectContaining({ multiple: true, exts: expect.arrayContaining([".mp4", ".jpg"]), have: ["/c/a.mp4"] }));
    expect(h.pickWith).not.toHaveBeenCalled();
    expect(project().sources.map((s) => s.path)).toEqual(["/c/a.mp4", "/c/b.mp4"]);
    expect(h.prepare).toHaveBeenCalledWith("p1", ["/c/b.mp4"], 30);
  });

  it("refreshes the states when the prepare job ends", async () => {
    open(["/c/a.mp4"], [st("/c/a.mp4")]);
    h.pickWith.mockResolvedValue(["/c/b.mp4"]);
    h.probe.mockResolvedValue([{ path: "/c/b.mp4", kind: "video", durationMs: 4000, error: "" }]);
    render(<SourcesPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(h.prepare).toHaveBeenCalled());
    h.sources.mockClear();
    act(() => useJobs.getState().upsert({ id: "job1", moduleId: "edit-studio", status: JobStatus.JobDone, progress: 1 } as unknown as Job));
    await waitFor(() => expect(h.sources).toHaveBeenCalled());
    expect(useEditStudio.getState().jobs.prepare).toBeUndefined();
  });

  it("tags: toggles a preset, adds a custom tag, filters", async () => {
    open(["/c/a.mp4", "/c/b.mp4"], [st("/c/a.mp4"), st("/c/b.mp4")]);
    render(<SourcesPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Tags for a.mp4" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "hero" }));
    expect(project().sources[0]?.tags).toEqual(["hero"]);
    await userEvent.click(screen.getByRole("button", { name: "Tags for a.mp4" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /New tag/ }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Tag" }), "Night Shot");
    await userEvent.click(screen.getByRole("button", { name: "Add tag" }));
    expect(project().sources[0]?.tags).toEqual(["hero", "night-shot"]);
    // filter
    await userEvent.click(within(screen.getByRole("group", { name: "Filter by tag" })).getByRole("button", { name: "hero" }));
    expect(screen.queryByRole("button", { name: "b.mp4" })).toBeNull();
    expect(screen.getByRole("button", { name: "a.mp4" })).toBeTruthy();
    // remove a tag via its chip
    await userEvent.click(screen.getByRole("button", { name: "Remove tag hero" }));
    expect(project().sources[0]?.tags).toEqual(["night-shot"]);
  });

  it("selection: click selects, Shift/Ctrl add, exposed through useSelectedSources", async () => {
    open(["/c/a.mp4", "/c/b.mp4", "/c/c.mp4"], [st("/c/a.mp4"), st("/c/b.mp4"), st("/c/c.mp4")]);
    render(
      <>
        <SourcesPanel />
        <Probe />
      </>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "a.mp4" }), { button: 0 });
    expect(screen.getByTestId("sel").textContent).toBe("/c/a.mp4");
    fireEvent.pointerDown(screen.getByRole("button", { name: "c.mp4" }), { button: 0, ctrlKey: true });
    expect(screen.getByTestId("sel").textContent).toBe("/c/a.mp4,/c/c.mp4");
    fireEvent.pointerDown(screen.getByRole("button", { name: "c.mp4" }), { button: 0, ctrlKey: true });
    expect(screen.getByTestId("sel").textContent).toBe("/c/a.mp4");
  });

  it("pressing a tile starts a pointer drag of the selected sources", () => {
    open(["/c/a.mp4", "/c/b.mp4"], [st("/c/a.mp4"), st("/c/b.mp4")]);
    render(<SourcesPanel />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "b.mp4" }), { button: 0, clientX: 3, clientY: 4, pointerId: 7 });
    expect(h.drag).toHaveBeenCalledTimes(1);
    expect(h.drag.mock.calls[0]?.[0]).toEqual(["/c/b.mp4"]);
  });

  it("double-click inserts the source at the playhead on the first unlocked video track", async () => {
    open(["/c/a.mp4"], [st("/c/a.mp4")]);
    useEditStudio.getState().setPlayhead(3000);
    render(<SourcesPanel />);
    await userEvent.dblClick(screen.getByRole("button", { name: "a.mp4" }));
    const clips = project().tracks[0]?.clips ?? [];
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ kind: "video", path: "/c/a.mp4", startMs: 3000, endMs: 15_000 });
    expect(useEditStudio.getState().selection).toEqual({ kind: "clips", ids: [clips[0]?.id] });
  });

  it("relinks a missing file in the sources and every clip", async () => {
    open(["/c/gone.mp4"], [st("/c/gone.mp4", { info: { error: "no such file" } })]);
    const doc = project();
    useEditStudio.getState().edit({ ...doc, tracks: [{ ...(doc.tracks[0] as NormalProject["tracks"][number]), clips: [{ id: "k1", kind: "video", path: "/c/gone.mp4", color: "", startMs: 0, endMs: 1000, inMs: 0, speed: "", slow: "", volume: 0, fit: "fill", fitColor: "#000000", flipX: false, blend: "normal", transform: "", matte: null, fxTarget: "clip", masks: "", effects: "", in: "", text: "", visual: "", pinned: false, auto: false }] }] });
    h.pickWith.mockResolvedValue(["/new/found.mp4"]);
    h.probe.mockResolvedValue([{ path: "/new/found.mp4", kind: "video", durationMs: 5000, error: "" }]);
    render(<SourcesPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Relink" }));
    await waitFor(() => expect(h.prepare).toHaveBeenCalledWith("p1", ["/new/found.mp4"], 30));
    expect(project().sources.map((s) => s.path)).toEqual(["/new/found.mp4"]);
    expect(project().tracks[0]?.clips[0]?.path).toBe("/new/found.mp4");
  });

  it("prepares every source again when the fps changes", async () => {
    open(["/c/a.mp4", "/c/b.mp4"], [st("/c/a.mp4"), st("/c/b.mp4")]);
    render(<SourcesPanel />);
    expect(h.prepare).not.toHaveBeenCalled();
    act(() => useEditStudio.getState().edit({ ...project(), fps: 60 }));
    await waitFor(() => expect(h.prepare).toHaveBeenCalledWith("p1", ["/c/a.mp4", "/c/b.mp4"], 60));
  });

  it("shows a used-count badge", () => {
    open(["/c/a.mp4"], [st("/c/a.mp4")]);
    const doc = project();
    const clip = (id: string, s: number) => ({ id, kind: "video", path: "/c/a.mp4", color: "", startMs: s, endMs: s + 500, inMs: 0, speed: "", slow: "", volume: 0, fit: "fill", fitColor: "#000000", flipX: false, blend: "normal", transform: "", matte: null, fxTarget: "clip", masks: "", effects: "", in: "", text: "", visual: "", pinned: false, auto: false });
    useEditStudio.getState().edit({ ...doc, tracks: [{ ...(doc.tracks[0] as NormalProject["tracks"][number]), clips: [clip("x", 0), clip("y", 1000)] }] });
    render(<SourcesPanel />);
    expect(within(screen.getByRole("button", { name: "a.mp4" })).getByText("2").getAttribute("data-tip")).toMatch(/Used in 2 clips/);
  });
});
