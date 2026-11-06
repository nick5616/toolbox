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
  del: vi.fn(),
  dup: vi.fn(),
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
      Delete: (...a: unknown[]) => h.del(...a),
      Duplicate: (...a: unknown[]) => h.dup(...a),
      Sources: async () => [],
      Mattes: async () => [],
    },
    FilesService: { PickWith: (...a: unknown[]) => h.pickWith(...a), ImageThumb: async () => "data:image/jpeg;base64,AA==" },
  };
});

import { ProjectKind, type ProjectInfo } from "@/lib/api";
import { useUI } from "@/state/ui";
import { emptyEditProject } from "@/viz/edit/defaults";
import { useEditStudio } from "@/editor/store";
import { discardedEdits } from "@/editor/useEditAutosave";
import { classifyInputs, routeInputs, useEditHandoff } from "./handoff";
import { useNewEditRequest } from "./newEditRequest";
import { ProjectsHome } from "./ProjectsHome";

const info = (id: string, name: string): ProjectInfo => ({ id, kind: ProjectKind.$zero, name, thumb: "", items: 3, missing: 0, updatedAt: Date.now(), flags: [] });

beforeEach(() => {
  Object.values(h).forEach((f) => f.mockReset());
  h.list.mockResolvedValue([]);
  h.get.mockImplementation(async () => emptyEditProject("9:16", 30, 1));
  h.save.mockResolvedValue(info("e1", "x"));
  h.prepare.mockResolvedValue({ id: "job1", status: "running", progress: 0 });
  useNewEditRequest.setState({ pending: null, songReplace: null });
  useEditStudio.getState().close();
  discardedEdits.clear();
});
afterEach(cleanup);

describe("ProjectsHome", () => {
  it("shows the empty state with a drop zone", async () => {
    render(<ProjectsHome moduleId="edit-studio" onOpen={() => undefined} />);
    expect(await screen.findByText("Drop a song to start an edit")).toBeTruthy();
    expect(document.getElementById("tool-drop:edit-studio")).toBeTruthy();
  });

  it("lists edits and opens one", async () => {
    h.list.mockResolvedValue([info("e1", "Night run"), info("e2", "Summer")]);
    const onOpen = vi.fn();
    render(<ProjectsHome moduleId="edit-studio" onOpen={onOpen} />);
    await userEvent.click(await screen.findByRole("button", { name: "Open Summer" }));
    expect(onOpen).toHaveBeenCalledWith("e2");
    expect(screen.getByText("Night run")).toBeTruthy();
  });

  it("renames with Get + Save", async () => {
    h.list.mockResolvedValue([info("e1", "Night run")]);
    render(<ProjectsHome moduleId="edit-studio" onOpen={() => undefined} />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Night run" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Rename/ }));
    const box = await screen.findByRole("textbox", { name: "Name" });
    await userEvent.clear(box);
    await userEvent.type(box, "Better name");
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(h.save).toHaveBeenCalled());
    expect(h.get).toHaveBeenCalledWith("e1");
    expect(h.save.mock.calls[0]?.[0]).toBe("e1");
    expect(h.save.mock.calls[0]?.[1]).toBe("Better name");
  });

  it("deletes after a confirm and marks the edit as discarded first", async () => {
    h.list.mockResolvedValue([info("e1", "Night run")]);
    h.del.mockImplementation(async (id: string) => {
      expect(discardedEdits.has(id)).toBe(true);
    });
    render(<ProjectsHome moduleId="edit-studio" onOpen={() => undefined} />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Night run" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(h.del).toHaveBeenCalledWith("e1"));
  });

  it("duplicates", async () => {
    h.list.mockResolvedValue([info("e1", "Night run")]);
    h.dup.mockResolvedValue(info("e2", "Night run copy"));
    render(<ProjectsHome moduleId="edit-studio" onOpen={() => undefined} />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Night run" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Duplicate/ }));
    await waitFor(() => expect(h.dup).toHaveBeenCalledWith("e1"));
  });

  it("creates an edit: Create, then Save with the song set, then opens it", async () => {
    h.pickWith.mockResolvedValue(["/music/My Song.mp3"]);
    h.probe.mockResolvedValue([{ path: "/music/My Song.mp3", kind: "audio", durationMs: 900_000, error: "" }]);
    h.create.mockResolvedValue(info("new1", "My Song"));
    const onOpen = vi.fn();
    render(<ProjectsHome moduleId="edit-studio" onOpen={onOpen} />);
    await userEvent.click((await screen.findAllByRole("button", { name: "New edit" }))[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Pick a song" }));
    await waitFor(() => expect((within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("My Song"));
    await userEvent.click(within(dialog).getByRole("radio", { name: /16:9/ }));
    await userEvent.click(within(dialog).getByRole("radio", { name: "60 fps" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("new1"));
    expect(h.create).toHaveBeenCalledWith("My Song", "16:9", 60);
    const saved = h.save.mock.calls[0] as [string, string, { song: Record<string, unknown> }];
    expect(saved[0]).toBe("new1");
    expect(saved[2].song).toEqual({ path: "/music/My Song.mp3", startMs: 0, endMs: 600_000, gainDb: 0, fadeInMs: 0, fadeOutMs: 500 });
  });

  it("opens the dialog prefilled from a request, queuing sources", async () => {
    h.probe.mockImplementation(async (paths: string[]) => paths.map((p) => ({ path: p, kind: p.endsWith(".jpg") ? "image" : p.endsWith(".mp3") ? "audio" : "video", durationMs: 200_000, error: "" })));
    h.create.mockResolvedValue(info("new2", "beat"));
    const onOpen = vi.fn();
    render(<ProjectsHome moduleId="edit-studio" onOpen={onOpen} />);
    useNewEditRequest.getState().request({ song: "/m/beat.mp3", sources: ["/c/a.mp4", "/c/b.jpg"] });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/2 clips and photos will be added/)).toBeTruthy();
    expect((within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("beat");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("new2"));
    const saved = h.save.mock.calls[0] as [string, string, { sources: Array<{ path: string }> }];
    expect(saved[2].sources.map((s) => s.path)).toEqual(["/c/a.mp4", "/c/b.jpg"]);
    expect(h.prepare).toHaveBeenCalledWith("new2", ["/c/a.mp4", "/c/b.jpg"], 30);
  });

  it("refuses a song that can't be read and stays open", async () => {
    h.probe.mockResolvedValue([{ path: "/m/x.mp3", kind: "", durationMs: 0, error: "no audio" }]);
    render(<ProjectsHome moduleId="edit-studio" onOpen={() => undefined} />);
    useNewEditRequest.getState().request({ song: "/m/x.mp3" });
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(h.probe).toHaveBeenCalled());
    expect(h.create).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("handoffs", () => {
  it("classifies inputs", () => {
    expect(classifyInputs(["/a/song.MP3", "/a/clip.mov", "/a/p.heic", "/a/notes.txt"])).toEqual({
      audio: ["/a/song.MP3"],
      media: ["/a/clip.mov", "/a/p.heic"],
      ignored: ["/a/notes.txt"],
    });
  });

  it("with no edit open, an audio file opens New edit with the song and queued sources", async () => {
    await routeInputs(["/a/song.mp3", "/a/clip.mp4"]);
    expect(useNewEditRequest.getState().pending).toEqual({ song: "/a/song.mp3", sources: ["/a/clip.mp4"] });
  });

  it("with no edit open, only clips open New edit with no song", async () => {
    await routeInputs(["/a/clip.mp4"]);
    expect(useNewEditRequest.getState().pending).toEqual({ sources: ["/a/clip.mp4"] });
  });

  it("with an edit open, an audio file asks before replacing the song", async () => {
    const doc = emptyEditProject("9:16", 30, 1);
    doc.song = { path: "/old.mp3", startMs: 0, endMs: 10_000, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 };
    useEditStudio.getState().open("p1", "Edit", doc as never);
    await routeInputs(["/a/new.mp3"]);
    expect(useNewEditRequest.getState().songReplace).toBe("/a/new.mp3");
  });

  it("with an edit open and no song yet, the audio file becomes the song at once and clears the analysis", async () => {
    h.probe.mockResolvedValue([{ path: "/a/new.mp3", kind: "audio", durationMs: 30_000, error: "" }]);
    const doc = emptyEditProject("9:16", 30, 1);
    doc.analysisKey = "stale";
    useEditStudio.getState().open("p1", "Edit", doc as never);
    await routeInputs(["/a/new.mp3"]);
    const p = useEditStudio.getState().history?.present;
    expect(p?.song).toEqual({ path: "/a/new.mp3", startMs: 0, endMs: 30_000, gainDb: 0, fadeInMs: 0, fadeOutMs: 500 });
    expect(p?.analysisKey).toBe("");
  });

  it("with an edit open, clips are probed, added to Sources and prepared", async () => {
    h.probe.mockResolvedValue([{ path: "/a/clip.mp4", kind: "video", durationMs: 5000, error: "" }]);
    useEditStudio.getState().open("p1", "Edit", emptyEditProject("9:16", 30, 1) as never);
    await routeInputs(["/a/clip.mp4"]);
    expect(useEditStudio.getState().history?.present.sources.map((s) => s.path)).toEqual(["/a/clip.mp4"]);
    expect(h.prepare).toHaveBeenCalledWith("p1", ["/a/clip.mp4"], 30);
  });

  it("useEditHandoff takes the handoff for the module", async () => {
    function Harness() {
      useEditHandoff("edit-studio", () => undefined);
      return null;
    }
    render(<Harness />);
    useUI.getState().handOff({ moduleId: "edit-studio", inputs: ["/a/song.mp3"] });
    await waitFor(() => expect(useNewEditRequest.getState().pending).toEqual({ song: "/a/song.mp3", sources: [] }));
    expect(useUI.getState().handoff).toBeNull();
  });
});
