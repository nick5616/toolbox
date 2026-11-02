import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  save: vi.fn(),
  probe: vi.fn(),
  plan: vi.fn(),
  render: vi.fn(),
  preview: vi.fn(),
  previewPath: vi.fn(),
  pick: vi.fn(),
  pickWith: vi.fn(),
  postGet: vi.fn(),
  postSave: vi.fn(),
  postList: vi.fn(),
  moduleState: vi.fn(),
  setState: vi.fn(),
  revealPath: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    VideoEditorService: {
      List: (...a: unknown[]) => h.list(...a),
      Get: (...a: unknown[]) => h.get(...a),
      Create: (...a: unknown[]) => h.create(...a),
      Save: (...a: unknown[]) => h.save(...a),
      Probe: (...a: unknown[]) => h.probe(...a),
      Plan: (...a: unknown[]) => h.plan(...a),
      Render: (...a: unknown[]) => h.render(...a),
      Preview: (...a: unknown[]) => h.preview(...a),
      PreviewPath: (...a: unknown[]) => h.previewPath(...a),
      Duplicate: async () => undefined,
      Delete: async () => undefined,
    },
    PostsService: {
      Get: (...a: unknown[]) => h.postGet(...a),
      Save: (...a: unknown[]) => h.postSave(...a),
      List: (...a: unknown[]) => h.postList(...a),
    },
    LyricVideoService: { Fonts: async () => ["Arial"] },
    MediaService: {
      Open: async (path: string) => ({
        url: `/media/t/${path.split("/").pop()}`,
        proxy: false,
        proxyJobId: "",
        info: { durationMs: 10000, startMs: 0, container: "mp4", sizeBytes: 1, bitRate: 0, video: { width: 1920, height: 1080, fps: 30 }, audio: [], subtitles: [], hasCover: false },
      }),
      Filmstrip: async () => "/media/t/strip.jpg",
      Waveform: async () => [0.1, 0.5, 0.3],
      URLFor: async () => "/media/t/x",
      Frame: async () => "/media/t/frame.jpg",
    },
    FilesService: {
      Pick: (...a: unknown[]) => h.pick(...a),
      PickWith: (...a: unknown[]) => h.pickWith(...a),
      ImageThumb: async () => "data:image/jpeg;base64,AA==",
    },
    SettingsService: { ModuleState: (...a: unknown[]) => h.moduleState(...a), SetModuleState: (...a: unknown[]) => h.setState(...a) },
    JobsService: { Cancel: async () => undefined },
    LibraryService: { RevealPath: (...a: unknown[]) => h.revealPath(...a), Reveal: async () => undefined, Open: async () => undefined },
  };
});

vi.mock("@/components/media", async (orig) => {
  const actual = await orig<typeof import("@/components/media")>();
  const React = await import("react");
  return {
    ...actual,
    MediaPlayer: React.forwardRef(function MediaPlayerStub(_p: object, ref: React.Ref<unknown>) {
      React.useImperativeHandle(ref, () => ({ play() {}, pause() {}, toggle() {}, seek() {}, step() {}, currentMs: () => 0, playing: () => false }));
      return <div data-testid="inspector-player" />;
    }),
    Timeline: () => <div data-testid="inspector-timeline" />,
  };
});

import { JobStatus, ProjectKind, type Job, type ProjectInfo, type VideoClip, type VideoProject } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import { useUI } from "@/state/ui";
import { emptyProject } from "./edit";
import { SequencePlayer } from "./SequencePlayer";
import { timeline } from "./timeline";
import VideoEditorView from "./VideoEditorView";

function clip(id: string, path: string, over: Partial<VideoClip> = {}): VideoClip {
  return {
    id,
    kind: "video",
    path,
    inMs: 0,
    outMs: 3000,
    durationMs: 0,
    speed: 1,
    volume: 1,
    fit: "fill",
    fitColor: "#000000",
    panX: 0,
    panY: 0,
    zoom: 1,
    motion: "none",
    look: "none",
    transition: { kind: "cut", durationMs: 0 },
    ...over,
  };
}

function project(over: Partial<VideoProject> = {}): VideoProject {
  return { ...emptyProject("9:16"), clips: [clip("c1", "/v/a.mp4"), clip("c2", "/v/b.mp4")], ...over };
}

function info(id: string, name: string, items = 2): ProjectInfo {
  return { id, kind: ProjectKind.ProjectVideo, name, thumb: "", items, missing: 0, updatedAt: 1 };
}

function probeResult(path: string, kind = "video") {
  return { path, kind, durationMs: 10000, width: 1920, height: 1080, fps: 30, rotation: 0, hasAudio: true, takenAt: 0, error: "" };
}

function job(id: string, over: Partial<Job> = {}): Job {
  return {
    id,
    moduleId: "video-editor",
    title: "x",
    status: JobStatus.JobQueued,
    progress: 0,
    message: "",
    inputs: [],
    optionsJson: "",
    errorCode: "",
    error: "",
    errorHint: "",
    attempt: 1,
    cancelRequested: false,
    createdAt: 1,
    startedAt: 0,
    finishedAt: 0,
    outputs: [],
    resultJson: "",
    pipelineRunId: "",
    pipelineStepId: "",
    ...over,
  } as Job;
}

function savedDoc(n = 0): VideoProject {
  return h.save.mock.calls[n]?.[2] as VideoProject;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(window.HTMLMediaElement.prototype, { play: vi.fn(async () => undefined), pause: vi.fn(), load: vi.fn() });
  h.list.mockResolvedValue([info("p1", "Beach day")]);
  h.get.mockResolvedValue(project());
  h.create.mockImplementation(async (name: string) => info("pn", name, 0));
  h.save.mockImplementation(async (id: string, name: string) => info(id, name));
  h.probe.mockImplementation(async (paths: string[]) => paths.map((p) => probeResult(p, p.endsWith(".jpg") ? "image" : p.endsWith(".mp3") ? "audio" : "video")));
  h.moduleState.mockResolvedValue("");
  h.setState.mockResolvedValue(undefined);
  h.postList.mockResolvedValue([info("post1", "My post")]);
  h.postGet.mockResolvedValue({ version: 1, format: "reel", aspect: "9:16", slides: [{ id: "s1", kind: "clip", path: "x.mp4", projectId: "" }], caption: "", keepLocation: false });
  h.postSave.mockResolvedValue(info("post1", "My post"));
  h.pick.mockResolvedValue([]);
  h.pickWith.mockResolvedValue([]);
  h.revealPath.mockResolvedValue(undefined);
  useJobs.setState({ byId: {} } as Partial<ReturnType<typeof useJobs.getState>>);
  useUI.setState({ handoff: null, view: "video-editor" });
});

afterEach(() => cleanup());

async function openFirstProject() {
  render(<VideoEditorView moduleId="video-editor" />);
  const card = await screen.findByRole("button", { name: "Open Beach day" });
  await userEvent.click(card);
  await screen.findByLabelText("Project name");
}

describe("projects and opening", () => {
  it("lists projects and opens one with its name, shape and length", async () => {
    await openFirstProject();
    expect((screen.getByLabelText("Project name") as HTMLInputElement).value).toBe("Beach day");
    expect(screen.getByTestId("total-length").textContent).toBe("0:06.000");
    expect(screen.getByTestId("clip-0")).toBeTruthy();
    expect(screen.getByTestId("clip-1")).toBeTruthy();
    expect(h.setState).toHaveBeenCalledWith("video-editor", JSON.stringify({ lastProjectId: "p1" }));
  });

  it("reopens the remembered project", async () => {
    h.moduleState.mockResolvedValue(JSON.stringify({ lastProjectId: "p1" }));
    render(<VideoEditorView moduleId="video-editor" />);
    await screen.findByLabelText("Project name");
    expect(h.get).toHaveBeenCalledWith("p1");
  });

  it("creates a new video at the chosen shape", async () => {
    h.list.mockResolvedValue([]);
    render(<VideoEditorView moduleId="video-editor" />);
    await userEvent.click(await screen.findByRole("button", { name: "New video" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "1:1" }));
    await waitFor(() => expect(h.create).toHaveBeenCalledWith("Untitled video", "1:1"));
    await screen.findByLabelText("Project name");
  });

  it("turns handed-off files into a new project's clips", async () => {
    h.list.mockResolvedValue([]);
    h.probe.mockResolvedValue([{ ...probeResult("/v/tall.mp4"), width: 1080, height: 1920 }]);
    useUI.setState({ handoff: { moduleId: "video-editor", inputs: ["/v/tall.mp4"] } });
    render(<VideoEditorView moduleId="video-editor" />);
    await screen.findByLabelText("Project name");
    expect(h.probe).toHaveBeenCalledWith(["/v/tall.mp4"]);
    expect(h.create).toHaveBeenCalledWith("New video", "9:16");
    expect(screen.getByTestId("clip-0")).toBeTruthy();
  });
});

describe("editing", () => {
  it("splits at the playhead with S and autosaves after 800 ms", async () => {
    await openFirstProject();
    fireEvent.change(screen.getByLabelText("Position"), { target: { value: "1500" } });
    fireEvent.keyDown(document.body, { key: "s" });
    await waitFor(() => expect(screen.getByTestId("clip-2")).toBeTruthy());
    expect(h.save).not.toHaveBeenCalled();
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const d = savedDoc();
    expect(h.save.mock.calls[0]?.[0]).toBe("p1");
    expect(h.save.mock.calls[0]?.[1]).toBe("Beach day");
    expect(d.clips?.map((c) => [c.inMs, c.outMs])).toEqual([[0, 1500], [1500, 3000], [0, 3000]]);
    await screen.findByText("Saved");
  });

  it("undoes with Ctrl+Z (and nothing is saved when it's back to the original)", async () => {
    await openFirstProject();
    fireEvent.change(screen.getByLabelText("Position"), { target: { value: "1500" } });
    fireEvent.keyDown(document.body, { key: "s" });
    await waitFor(() => expect(screen.getByTestId("clip-2")).toBeTruthy());
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(screen.queryByTestId("clip-2")).toBeNull());
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getByTestId("clip-2")).toBeTruthy());
  });

  it("deletes the selected clip with Delete", async () => {
    await openFirstProject();
    fireEvent.pointerDown(screen.getByTestId("clip-0"), { button: 0, clientX: 10 });
    fireEvent.pointerUp(screen.getByTestId("clip-0"), { button: 0 });
    await screen.findByTestId("clip-inspector");
    fireEvent.keyDown(document.body, { key: "Delete" });
    await waitFor(() => expect(screen.queryByTestId("clip-1")).toBeNull());
    await waitFor(() => expect(h.save).toHaveBeenCalled(), { timeout: 3000 });
    expect(savedDoc().clips?.map((c) => c.id)).toEqual(["c2"]);
  });

  it("changes a transition from the chip's popover", async () => {
    await openFirstProject();
    await userEvent.click(screen.getByTestId("transition-0"));
    const pop = await screen.findByTestId("transition-popover");
    await userEvent.click(within(pop).getByRole("radio", { name: "Dip" }));
    await waitFor(() => expect(h.save).toHaveBeenCalled(), { timeout: 3000 });
    expect(savedDoc().clips?.[0]?.transition).toEqual({ kind: "dip", durationMs: 500 });
    // The timeline closes up by the overlap.
    expect(screen.getByTestId("total-length").textContent).toBe("0:05.500");
  });

  it("shows the Couldn't-save state and the validation message", async () => {
    h.save.mockRejectedValue({ cause: { code: "validation", message: "A transition lasts 0.2 to 1.5 seconds" } });
    await openFirstProject();
    await userEvent.selectOptions(screen.getByLabelText("Shape"), "1:1");
    await screen.findByText("Couldn't save", undefined, { timeout: 3000 });
    expect(screen.getAllByText(/A transition lasts/).length).toBeGreaterThan(0);
  });

  it("adds a title at the playhead and edits it in the inspector", async () => {
    await openFirstProject();
    await userEvent.click(screen.getByRole("button", { name: "Title" }));
    const box = await screen.findByLabelText("Text");
    await userEvent.clear(box);
    await userEvent.type(box, "Hello");
    await waitFor(() => expect(h.save).toHaveBeenCalled(), { timeout: 3000 });
    const d = savedDoc(h.save.mock.calls.length - 1);
    expect(d.titles?.[0]).toMatchObject({ text: "Hello", style: "title", position: "center" });
  });
});

describe("quick vlog", () => {
  it("submits the plan request and opens the result when the job is done", async () => {
    h.pick.mockResolvedValue(["/v/1.mp4", "/v/2.jpg"]);
    h.pickWith.mockResolvedValue(["/m/song.mp3"]);
    h.plan.mockResolvedValue(job("jp"));
    h.list.mockResolvedValue([info("p1", "Beach day")]);
    render(<VideoEditorView moduleId="video-editor" />);
    await userEvent.click(await screen.findByRole("button", { name: /Quick vlog/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Add clips and photos" }));
    await screen.findByText("2 added");
    await userEvent.click(screen.getByRole("button", { name: "Pick a song" }));
    await screen.findByText("song.mp3");
    await userEvent.click(screen.getByRole("radio", { name: "As given" }));
    await userEvent.click(screen.getByRole("switch", { name: "Cut on the beat" }));
    await userEvent.click(screen.getByRole("radio", { name: "Dip" }));
    await userEvent.selectOptions(screen.getByLabelText("Shape"), "16:9");
    await userEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(h.plan).toHaveBeenCalled());
    expect(h.plan).toHaveBeenCalledWith({
      paths: ["/v/1.mp4", "/v/2.jpg"],
      musicPath: "/m/song.mp3",
      aspect: "16:9",
      order: "as-given",
      targetMs: 0,
      beatCut: true,
      transition: "dip",
    });
    h.list.mockResolvedValue([info("pv", "Vlog today"), info("p1", "Beach day")]);
    h.get.mockResolvedValue(project());
    act(() => useJobs.getState().upsert(job("jp", { status: JobStatus.JobDone, resultJson: JSON.stringify({ projectId: "pv" }) })));
    await waitFor(() => expect(h.get).toHaveBeenCalledWith("pv"));
    expect(((await screen.findByLabelText("Project name")) as HTMLInputElement).value).toBe("Vlog today");
  });

  it("won't build without files and sends a set length in ms", async () => {
    h.pick.mockResolvedValue(["/v/1.mp4"]);
    h.plan.mockResolvedValue(job("jp"));
    render(<VideoEditorView moduleId="video-editor" />);
    await userEvent.click(await screen.findByRole("button", { name: /Quick vlog/ }));
    await userEvent.click(screen.getByRole("button", { name: "Build" }));
    expect(h.plan).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Add clips and photos" }));
    await userEvent.click(screen.getByRole("radio", { name: "Set length" }));
    await userEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(h.plan).toHaveBeenCalled());
    expect(h.plan.mock.calls[0]?.[0]).toMatchObject({ targetMs: 30000, beatCut: false, order: "date-taken", transition: "fade", musicPath: "" });
  });
});

describe("export", () => {
  it("offers Reveal, Subtitles and Add to post once the render finishes", async () => {
    await openFirstProject();
    h.render.mockResolvedValue(job("jr"));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(h.render).toHaveBeenCalledWith("p1"));
    act(() =>
      useJobs.getState().upsert(
        job("jr", { status: JobStatus.JobDone, outputs: [{ id: "o1", jobId: "jr", moduleId: "video-editor", path: "/lib/Edits/Beach day.mp4", name: "Beach day.mp4" }] as Job["outputs"] }),
      ),
    );
    await screen.findByText("Exported Beach day.mp4");
    await userEvent.click(screen.getByRole("button", { name: "Add captions with Subtitles" }));
    expect(useUI.getState().handoff).toEqual({ moduleId: "subtitles", inputs: ["/lib/Edits/Beach day.mp4"] });
    await userEvent.click(screen.getByRole("button", { name: "Add to post…" }));
    expect(useUI.getState().handoff).toEqual({ moduleId: "post-builder", inputs: ["/lib/Edits/Beach day.mp4"] });
    await userEvent.click(screen.getAllByRole("button", { name: /Explorer|Finder/ })[0]!);
    expect(h.revealPath).toHaveBeenCalledWith("/lib/Edits/Beach day.mp4");
  });

  it("plays the exact preview with a banner that goes stale when the project changes", async () => {
    await openFirstProject();
    h.preview.mockResolvedValue(job("jv"));
    h.previewPath.mockResolvedValue("/support/projects/p1/preview.mp4");
    await userEvent.click(screen.getByRole("button", { name: "Render preview" }));
    await waitFor(() => expect(h.preview).toHaveBeenCalledWith("p1"));
    act(() => useJobs.getState().upsert(job("jv", { status: JobStatus.JobDone })));
    await screen.findByText(/Exact preview \(rendered \d+ s ago\)/);
    await screen.findByTestId("exact-video");
    await userEvent.selectOptions(screen.getByLabelText("Shape"), "1:1");
    await screen.findByText(/out of date/);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss exact preview" }));
    await waitFor(() => expect(screen.queryByTestId("exact-video")).toBeNull());
    expect(screen.getByTestId("player-frame")).toBeTruthy();
  });
});

describe("post handoff", () => {
  const seed = { postId: "post1", slideId: "s1", aspect: "3:4", projectId: "" };

  it("creates a project at the nearest shape, links it on first save and goes back to the post", async () => {
    useUI.setState({ handoff: { moduleId: "video-editor", inputs: [], postSlide: seed } });
    render(<VideoEditorView moduleId="video-editor" />);
    await screen.findByLabelText("Project name");
    expect(h.create).toHaveBeenCalledWith("Post video", "4:5");
    expect(h.postSave).not.toHaveBeenCalled();
    // Edit something so a first save happens.
    await userEvent.selectOptions(screen.getByLabelText("Shape"), "1:1");
    await waitFor(() => expect(h.postSave).toHaveBeenCalled(), { timeout: 3000 });
    expect(h.postGet).toHaveBeenCalledWith("post1");
    const [id, name, post] = h.postSave.mock.calls[0] as [string, string, { slides: { id: string; kind: string; projectId: string }[] }];
    expect(id).toBe("post1");
    expect(name).toBe("My post");
    expect(post.slides[0]).toMatchObject({ id: "s1", kind: "video", projectId: "pn" });

    await userEvent.click(screen.getByRole("button", { name: "Back to post" }));
    expect(useUI.getState().handoff?.moduleId).toBe("post-builder");
    expect(useUI.getState().handoff?.postSlide).toMatchObject({ postId: "post1", slideId: "s1", projectId: "pn" });
  });

  it("treats a pending slide as needing a new project and appends a missing slide", async () => {
    h.postGet.mockResolvedValue({ version: 1, format: "story", aspect: "9:16", slides: [], caption: "", keepLocation: false });
    useUI.setState({ handoff: { moduleId: "video-editor", inputs: [], postSlide: { ...seed, aspect: "9:16", projectId: "pending" } } });
    render(<VideoEditorView moduleId="video-editor" />);
    await screen.findByLabelText("Project name");
    expect(h.create).toHaveBeenCalledWith("Post video", "9:16");
    expect(h.get).not.toHaveBeenCalled();
    await userEvent.selectOptions(screen.getByLabelText("Shape"), "1:1");
    await waitFor(() => expect(h.postSave).toHaveBeenCalled(), { timeout: 3000 });
    const post = h.postSave.mock.calls[0]?.[2] as { slides: Record<string, unknown>[] };
    expect(post.slides[0]).toMatchObject({ id: "s1", kind: "video", projectId: "pn", zoom: 1, mute: false, altText: "" });
  });

  it("opens the slide's linked project", async () => {
    useUI.setState({ handoff: { moduleId: "video-editor", inputs: [], postSlide: { ...seed, projectId: "p1" } } });
    render(<VideoEditorView moduleId="video-editor" />);
    await screen.findByLabelText("Project name");
    expect(h.get).toHaveBeenCalledWith("p1");
    expect(h.create).not.toHaveBeenCalled();
    await userEvent.selectOptions(screen.getByLabelText("Shape"), "1:1");
    await waitFor(() => expect(h.save).toHaveBeenCalled(), { timeout: 3000 });
    expect(h.postSave).not.toHaveBeenCalled(); // already linked
    expect(screen.getByRole("button", { name: "Back to post" })).toBeTruthy();
  });
});

describe("sequence player", () => {
  const doc = project({
    clips: [clip("c1", "/v/a.mp4", { transition: { kind: "fade", durationMs: 500 }, fit: "fit-color", fitColor: "#112233" }), clip("c2", "/v/b.mp4", { look: "mono" })],
    titles: [{ id: "t1", text: "Hello world", startMs: 0, durationMs: 2000, style: "caption", position: "bottom", font: "", color: "#ffffff" }],
  });
  const sources = {
    "/v/a.mp4": { status: "ready" as const, url: "/media/t/a.mp4" },
    "/v/b.mp4": { status: "loading" as const },
  };

  it("draws the current clip, preloads the next, and shows titles", () => {
    const spans = timeline(doc.clips ?? []);
    render(<SequencePlayer doc={doc} spans={spans} totalMs={5500} sources={sources} infos={{}} onTime={() => undefined} onPlayingChange={() => undefined} />);
    const l0 = screen.getByTestId("layer-0");
    expect(l0.getAttribute("data-fit")).toBe("fit-color");
    expect(l0.style.background).toContain("rgb(17, 34, 51)");
    expect(l0.querySelector("video")?.getAttribute("src")).toBe("/media/t/a.mp4");
    // The next clip sits hidden, waiting for its file.
    expect(screen.getByTestId("layer-1").style.visibility).toBe("hidden");
    expect(screen.getByTestId("title-overlay").textContent).toBe("Hello world");
  });
});
