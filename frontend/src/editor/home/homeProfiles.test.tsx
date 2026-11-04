import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  save: vi.fn(),
  probe: vi.fn(),
  prepare: vi.fn(),
  older: vi.fn(),
  moduleState: vi.fn(),
  setModuleState: vi.fn(),
  pickWith: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    EditStudioService: {
      List: (...a: unknown[]) => h.list(...a),
      Get: (...a: unknown[]) => h.get(...a),
      Create: (...a: unknown[]) => h.create(...a),
      Save: (...a: unknown[]) => h.save(...a),
      Probe: (...a: unknown[]) => h.probe(...a),
      Prepare: (...a: unknown[]) => h.prepare(...a),
      Delete: async () => undefined,
      Duplicate: async () => undefined,
      Sources: async () => [],
      Mattes: async () => [],
    },
    VideoEditorService: { List: (...a: unknown[]) => h.older(...a) },
    SettingsService: { ModuleState: (...a: unknown[]) => h.moduleState(...a), SetModuleState: (...a: unknown[]) => h.setModuleState(...a) },
    FilesService: { PickWith: (...a: unknown[]) => h.pickWith(...a), ImageThumb: async () => "data:image/jpeg;base64,AA==" },
  };
});

import { ProjectKind, type ProjectInfo } from "@/lib/api";
import { useUI } from "@/state/ui";
import { emptyEditProject, normalizeProject } from "@/viz/edit/defaults";
import { useEditStudio } from "@/editor/store";
import type { EditorProfile } from "@/editor/profile";
import { routeInputs, VIDEO_EDITOR_ID } from "./handoff";
import { useNewEditRequest } from "./newEditRequest";
import { layoutFiles, musicBed } from "./newVideo";
import { ProjectsHome } from "./ProjectsHome";

const info = (id: string, name: string, flags: string[] = []): ProjectInfo => ({ id, kind: ProjectKind.$zero, name, thumb: "", items: 3, missing: 0, updatedAt: Date.now(), flags });

const VIDEO: EditorProfile = { moduleId: "video-studio", noun: "video", song: "optional", homeFilter: "all", markerSignals: false };
const MUSIC: EditorProfile = { moduleId: "edit-studio", noun: "edit", song: "analyzed", homeFilter: "music-edit", markerSignals: true };

beforeEach(() => {
  Object.values(h).forEach((f) => f.mockReset());
  h.list.mockResolvedValue([]);
  h.older.mockResolvedValue([]);
  h.moduleState.mockResolvedValue("");
  h.setModuleState.mockResolvedValue(undefined);
  h.get.mockImplementation(async () => emptyEditProject("9:16", 30, 1));
  h.save.mockResolvedValue(info("e1", "x"));
  h.prepare.mockResolvedValue({ id: "job1", status: "running", progress: 0 });
  useNewEditRequest.setState({ pending: null, songReplace: null });
  useEditStudio.getState().close();
});
afterEach(cleanup);

describe("Video Editor home", () => {
  it("lists every project with a quiet badge on music edits", async () => {
    h.list.mockResolvedValue([info("e1", "Plain"), info("e2", "Beat cut", ["music", "music-edit"])]);
    render(<ProjectsHome moduleId="video-studio" profile={VIDEO} onOpen={() => undefined} />);
    expect(await screen.findByRole("button", { name: "Open Plain" })).toBeTruthy();
    const beat = screen.getByRole("button", { name: "Open Beat cut" });
    expect(within(beat).getByText("Music edit")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: "Open Plain" })).queryByText("Music edit")).toBeNull();
  });

  it("New video creates without a song, laying files out and making the audio the music", async () => {
    h.pickWith.mockResolvedValue(["/c/a.mp4", "/c/b.jpg", "/m/s.mp3"]);
    h.probe.mockResolvedValue([
      { path: "/c/a.mp4", kind: "video", durationMs: 4000, error: "" },
      { path: "/c/b.jpg", kind: "image", durationMs: 0, error: "" },
      { path: "/m/s.mp3", kind: "audio", durationMs: 90_000, error: "" },
    ]);
    h.create.mockResolvedValue(info("v1", "a"));
    const onOpen = vi.fn();
    render(<ProjectsHome moduleId="video-studio" profile={VIDEO} onOpen={onOpen} />);
    await userEvent.click((await screen.findAllByRole("button", { name: "New video" }))[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add files" }));
    await waitFor(() => expect(within(dialog).getByText("3 files")).toBeTruthy());
    await userEvent.click(within(dialog).getByRole("radio", { name: "60 fps" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("v1"));
    expect(h.create).toHaveBeenCalledWith("a", "9:16", 60);
    const saved = h.save.mock.calls[0] as [string, string, ReturnType<typeof normalizeProject>];
    const clips = saved[2].tracks[0]?.clips ?? [];
    expect(clips.map((c) => [c.kind, c.startMs, c.endMs])).toEqual([
      ["video", 0, 4000],
      ["image", 4000, 7000],
    ]);
    expect(saved[2].song).toEqual({ path: "/m/s.mp3", startMs: 0, endMs: 7000, gainDb: 0, fadeInMs: 0, fadeOutMs: 500 });
    expect(h.prepare).toHaveBeenCalledWith("v1", ["/c/a.mp4", "/c/b.jpg"], 60);
  });

  it("New video works with no files at all", async () => {
    h.create.mockResolvedValue(info("v2", "Untitled video"));
    const onOpen = vi.fn();
    render(<ProjectsHome moduleId="video-studio" profile={VIDEO} onOpen={onOpen} />);
    await userEvent.click((await screen.findAllByRole("button", { name: "New video" }))[0] as HTMLElement);
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("v2"));
    expect(h.probe).not.toHaveBeenCalled();
    const saved = h.save.mock.calls[0] as [string, string, { song: unknown }];
    expect(saved[2].song).toBeNull();
  });

  it("lists older sequence projects; Open and Quick vlog go to the Sequence Editor through its module state", async () => {
    h.older.mockResolvedValue([info("old1", "Holiday cut")]);
    h.moduleState.mockResolvedValue(JSON.stringify({ lastProjectId: "x", other: 1 }));
    render(<ProjectsHome moduleId="video-studio" profile={VIDEO} onOpen={() => undefined} />);
    await userEvent.click(await screen.findByRole("button", { name: "Open Holiday cut in the sequence editor" }));
    await waitFor(() => expect(useUI.getState().view).toBe("video-editor"));
    expect(h.setModuleState).toHaveBeenLastCalledWith("video-editor", JSON.stringify({ lastProjectId: "old1", other: 1 }));

    await userEvent.click(screen.getByRole("button", { name: "Quick vlog…" }));
    await waitFor(() => expect(h.setModuleState).toHaveBeenCalledTimes(2));
    expect(JSON.parse(h.setModuleState.mock.calls[1]?.[1] as string)).toMatchObject({ quickVlog: true });
  });

  it("a request (drop or handoff) opens New video with the files", async () => {
    render(<ProjectsHome moduleId="video-studio" profile={VIDEO} onOpen={() => undefined} />);
    useNewEditRequest.getState().request({ files: ["/m/s.mp3", "/c/a.mp4"] });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("2 files")).toBeTruthy();
  });
});

describe("Edit Studio home", () => {
  it("shows music edits first and folds the rest away", async () => {
    h.list.mockResolvedValue([info("e1", "Plain"), info("e2", "Beat cut", ["music", "music-edit"])]);
    render(<ProjectsHome moduleId="edit-studio" profile={MUSIC} onOpen={() => undefined} />);
    expect(await screen.findByRole("button", { name: "Open Beat cut" })).toBeTruthy();
    const fold = screen.getByText(/Videos without a song analysis \(1\)/).closest("details") as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(within(fold).getByRole("button", { name: "Open Plain" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Edits" }).textContent).not.toContain("Plain");
    expect(screen.queryByText("Older sequence projects")).toBeNull();
    expect(h.older).not.toHaveBeenCalled();
  });

  it("opens the plain New edit dialog", async () => {
    render(<ProjectsHome moduleId="edit-studio" profile={MUSIC} onOpen={() => undefined} />);
    await userEvent.click((await screen.findAllByRole("button", { name: "New edit" }))[0] as HTMLElement);
    expect(within(await screen.findByRole("dialog")).getByRole("button", { name: "Pick a song" })).toBeTruthy();
  });
});

describe("handoffs per tool", () => {
  it("Video Editor: files, audio first, become one new-video request", async () => {
    await routeInputs(["/a/clip.mp4", "/a/song.mp3", "/a/p.jpg"], VIDEO_EDITOR_ID);
    expect(useNewEditRequest.getState().pending).toEqual({ files: ["/a/song.mp3", "/a/clip.mp4", "/a/p.jpg"] });
  });

  it("Video Editor with a project open: audio becomes the music bed (analysis untouched)", async () => {
    h.probe.mockResolvedValue([{ path: "/a/new.mp3", kind: "audio", durationMs: 30_000, error: "" }]);
    const doc = emptyEditProject("9:16", 30, 1);
    doc.analysisKey = "keep";
    useEditStudio.getState().open("p1", "Video", doc as never);
    await routeInputs(["/a/new.mp3"], VIDEO_EDITOR_ID);
    const p = useEditStudio.getState().history?.present;
    expect(p?.song?.path).toBe("/a/new.mp3");
    expect(p?.song?.endMs).toBe(30_000);
    expect(p?.analysisKey).toBe("keep");
  });

  it("Edit Studio is unchanged", async () => {
    await routeInputs(["/a/song.mp3", "/a/clip.mp4"], "edit-studio");
    expect(useNewEditRequest.getState().pending).toEqual({ song: "/a/song.mp3", sources: ["/a/clip.mp4"] });
  });
});

describe("layoutFiles / musicBed", () => {
  const doc = () => normalizeProject(emptyEditProject("9:16", 30, 1));
  const v = (path: string, durationMs: number) => ({ path, kind: "video", durationMs, error: "" });

  it("places clips back to back, photos 3 s, skipping unreadable files", () => {
    const { project, media } = layoutFiles(doc(), [v("/a.mp4", 2500), { path: "/b.png", kind: "image", durationMs: 0, error: "" }, { path: "/bad.mp4", kind: "", durationMs: 0, error: "x" }, v("/c.mp4", 1000)]);
    expect(project.tracks[0]?.clips.map((c) => [c.path, c.startMs, c.endMs])).toEqual([
      ["/a.mp4", 0, 2500],
      ["/b.png", 2500, 5500],
      ["/c.mp4", 5500, 6500],
    ]);
    expect(media).toEqual(["/a.mp4", "/b.png", "/c.mp4"]);
    expect(project.sources.map((s) => s.path)).toEqual(media);
    expect(project.song).toBeNull();
  });

  it("the music bed is min(audio, clips end, 10 min)", () => {
    expect(musicBed("/s.mp3", 90_000, 7000).endMs).toBe(7000);
    expect(musicBed("/s.mp3", 5000, 7000).endMs).toBe(5000);
    expect(musicBed("/s.mp3", 900_000, 0).endMs).toBe(600_000);
    expect(musicBed("/s.mp3", 900_000, 800_000).endMs).toBe(600_000);
    expect(musicBed("/s.mp3", 1500, 200).endMs).toBe(1000);
  });
});
