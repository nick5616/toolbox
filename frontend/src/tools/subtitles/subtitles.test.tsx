import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const load = vi.hoisted(() => vi.fn());
const translatorStatus = vi.hoisted(() => vi.fn());
const open = vi.hoisted(() => vi.fn());
const pickWith = vi.hoisted(() => vi.fn());
const copy = vi.hoisted(() => vi.fn());
const libPick = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    SubtitlesService: {
      Enqueue: (...a: unknown[]) => enqueue(...a),
      Load: (...a: unknown[]) => load(...a),
      TranslatorStatus: () => translatorStatus(),
      TranslationLanguages: async () => [
        { code: "es", name: "Spanish" },
        { code: "en", name: "English" },
      ],
      Styles: async () => [
        { id: "classic", label: "Classic" },
        { id: "boxed", label: "Boxed" },
      ],
    },
    TranscribeService: { Languages: async () => [{ code: "en", name: "English" }] },
    LyricVideoService: { Fonts: async () => ["Arial", "Georgia"] },
    MediaService: {
      Open: (...a: unknown[]) => open(...a),
      Frame: async () => "/media/t/frame.jpg",
      Filmstrip: async () => "/media/t/strip.jpg",
      Waveform: async () => [0.1, 0.5],
      Keyframes: async () => [],
    },
    FilesService: { PickWith: (...a: unknown[]) => pickWith(...a), Pick: async () => [], Stat: async () => [] },
    JobsService: { Cancel: async () => undefined },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    LibraryService: { Reveal: async () => undefined, RevealPath: async () => undefined, Open: async () => undefined },
    ClipboardService: { CopyText: (...a: unknown[]) => copy(...a) },
  };
});

// "From Library…" resolves with these paths instead of opening the dialog.
vi.mock("@/blocks/library-picker/pick", async (orig) => {
  const actual = await orig<typeof import("@/blocks/library-picker/pick")>();
  return { ...actual, pickFromLibrary: (...a: unknown[]) => libPick(...a) };
});

// The real player drives a <video>; jsdom can't play, so stand in for it and the timeline.
vi.mock("@/components/media", async (orig) => {
  const actual = await orig<typeof import("@/components/media")>();
  return {
    ...actual,
    MediaPlayer: () => <div data-testid="player" />,
    Timeline: () => <div data-testid="timeline" />,
  };
});

import { JobStatus, ModuleStatus, type Descriptor, type Job } from "@/lib/api";
import { registerToolViews } from "@/lib/toolActions";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import SubtitlesView from "./SubtitlesView";
import { initialData, useSubtitles } from "./store";

const CUES = [
  { startMs: 0, endMs: 2000, text: "Hello" },
  { startMs: 2500, endMs: 4000, text: "World" },
  { startMs: 5000, endMs: 6000, text: "Bye" },
];

function job(over: Partial<Job>): Job {
  return {
    id: "j1",
    moduleId: "subtitles",
    title: "Subtitles",
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
    startedAt: 1,
    finishedAt: 0,
    outputs: [],
    resultJson: "",
    ...over,
  } as unknown as Job;
}

const VIDEO_SOURCE = {
  url: "/media/t/v.mp4",
  proxy: false,
  proxyJobId: "",
  info: {
    durationMs: 60000,
    startMs: 0,
    container: "mov",
    sizeBytes: 1,
    bitRate: 0,
    video: { index: 0, codec: "h264", width: 1920, height: 1080, fps: 30 },
    audio: [],
    subtitles: [
      { index: 2, codec: "subrip", language: "eng", title: "English", text: true },
      { index: 3, codec: "hdmv_pgs_subtitle", language: "fra", title: "", text: false },
    ],
    hasCover: false,
    tags: null,
  },
};

function handOff(inputs: string[]) {
  act(() => useUI.getState().handOff({ moduleId: "subtitles", inputs }));
}

type User = ReturnType<typeof userEvent.setup>;

/** Opens a panel from the header or the rail (both launch the same drawer). */
async function openPanel(user: User, name: string, dialog = name) {
  const launcher = screen.getAllByRole("button", { name: new RegExp(`^${name}`) })[0]!;
  await user.click(launcher);
  return screen.findByRole("dialog", { name: dialog });
}

async function openSubtitleFile(user: User) {
  load.mockResolvedValue(CUES);
  render(<SubtitlesView moduleId="subtitles" />);
  handOff(["/in/talk.srt"]);
  await screen.findByLabelText("Subtitle 1 text");
  return user;
}

describe("SubtitlesView", () => {
  beforeEach(() => {
    enqueue.mockReset();
    load.mockReset();
    open.mockReset();
    pickWith.mockReset();
    copy.mockReset();
    translatorStatus.mockReset();
    translatorStatus.mockResolvedValue({ ready: true, model: "Qwen 3", error: "" });
    open.mockResolvedValue(VIDEO_SOURCE);
    useJobs.setState({ byId: {} });
    useUI.setState({ handoff: null, view: "subtitles" });
    useSubtitles.setState(initialData());
  });

  it("starts empty with a drop zone and the two ways in, and no stepper", () => {
    render(<SubtitlesView moduleId="subtitles" />);
    expect(screen.getByText(/Drop a video, an audio file, or an \.srt/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Choose a video or audio file/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Use a subtitle file/ })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Steps" })).toBeNull();
  });

  it("loads a dropped subtitle file straight into the workspace", async () => {
    const user = userEvent.setup();
    await openSubtitleFile(user);
    expect(load).toHaveBeenCalledWith("/in/talk.srt");
    expect(screen.getAllByTestId("cue-row")).toHaveLength(3);
    expect((screen.getByLabelText("Subtitle 2 text") as HTMLTextAreaElement).value).toBe("World");
    // No video: the stage offers to pick one; the source chip names the subtitle file.
    expect(screen.getByText("No video to preview against")).toBeTruthy();
    expect(screen.getByText("talk.srt")).toBeTruthy();
  });

  it("shows an error when the subtitle file can't be read", async () => {
    load.mockRejectedValue({ code: "validation", message: "Not a subtitle file" });
    render(<SubtitlesView moduleId="subtitles" />);
    handOff(["/in/bad.srt"]);
    expect(await screen.findByText("Not a subtitle file")).toBeTruthy();
    expect(screen.getByText("Couldn't read the subtitles")).toBeTruthy();
  });

  it("edits text, marks it unsaved, supports undo, and saves with the cues (Export)", async () => {
    const user = userEvent.setup();
    await openSubtitleFile(user);
    const text = screen.getByLabelText("Subtitle 2 text");
    await user.clear(text);
    await user.type(text, "Planet");
    expect(screen.getByLabelText("Unsaved changes")).toBeTruthy();

    const panel = await openPanel(user, "Export");
    enqueue.mockResolvedValue([job({ id: "s1" })]);
    await user.click(within(panel).getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    const [inputs, opts] = enqueue.mock.calls[0] as [string[], { action: string; cues: Array<{ text: string }>; formats: string[] }];
    expect(inputs).toEqual(["/in/talk.srt"]);
    expect(opts.action).toBe("save");
    expect(opts.formats).toEqual(["srt"]);
    expect(opts.cues.map((c) => c.text)).toEqual(["Hello", "Planet", "Bye"]);

    // The job finishes: the dot goes away and a result card appears.
    act(() =>
      useJobs.getState().upsert(
        job({
          id: "s1",
          status: JobStatus.JobDone,
          progress: 1,
          resultJson: JSON.stringify({ action: "save", language: "", cues: 3, outputs: ["/o/Subtitles/talk.srt"] }),
        }) as never,
      ),
    );
    await screen.findByText("Saved");
    await waitFor(() => expect(screen.queryByLabelText("Unsaved changes")).toBeNull());
  });

  it("merges a cue with the next from its row menu, then undoes it", async () => {
    const user = userEvent.setup();
    await openSubtitleFile(user);
    await user.click(screen.getByRole("button", { name: "Subtitle 1 actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Merge with next" }));
    expect(screen.getAllByTestId("cue-row")).toHaveLength(2);
    expect((screen.getByLabelText("Subtitle 1 text") as HTMLTextAreaElement).value).toBe("Hello World");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getAllByTestId("cue-row")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Redo" }));
    expect(screen.getAllByTestId("cue-row")).toHaveLength(2);
  });

  it("splits with Ctrl+Enter at the caret", async () => {
    const user = userEvent.setup();
    await openSubtitleFile(user);
    const text = screen.getByLabelText("Subtitle 1 text") as HTMLTextAreaElement;
    await user.clear(text);
    await user.type(text, "Hello brave world");
    text.setSelectionRange(11, 11);
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(screen.getAllByTestId("cue-row")).toHaveLength(4);
    expect((screen.getByLabelText("Subtitle 1 text") as HTMLTextAreaElement).value).toBe("Hello brave");
    expect((screen.getByLabelText("Subtitle 2 text") as HTMLTextAreaElement).value).toBe("world");
  });

  it("flags an empty cue and blocks saving", async () => {
    const user = userEvent.setup();
    await openSubtitleFile(user);
    await user.clear(screen.getByLabelText("Subtitle 3 text"));
    expect(screen.getByText("Subtitle 3: Text is empty")).toBeTruthy();
    const panel = await openPanel(user, "Export");
    expect((within(panel).getByRole("button", { name: /^Save/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shifts all times from the cue list toolbar", async () => {
    const user = userEvent.setup();
    await openSubtitleFile(user);
    await user.click(screen.getByRole("button", { name: "Shift timing" }));
    const stepper = screen.getByLabelText("Subtitles are late by");
    await user.clear(stepper);
    await user.type(stepper, "500{Enter}");
    await user.click(screen.getByRole("button", { name: "Shift" }));
    expect((screen.getByLabelText("Subtitle 2 start") as HTMLInputElement).value).toBe("0:02.000");
  });

  it("finds and replaces", async () => {
    const user = userEvent.setup();
    await openSubtitleFile(user);
    await user.click(screen.getByRole("button", { name: "Find and replace" }));
    await user.type(screen.getByLabelText("Find"), "o");
    await user.type(screen.getByLabelText("Replace with"), "0");
    await user.click(screen.getByRole("button", { name: "Replace all" }));
    expect((screen.getByLabelText("Subtitle 1 text") as HTMLTextAreaElement).value).toBe("Hell0");
    expect((screen.getByLabelText("Subtitle 2 text") as HTMLTextAreaElement).value).toBe("W0rld");
  });

  it("windows the list above 200 cues", async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 800, text: `line ${i}` }));
    load.mockResolvedValue(many);
    render(<SubtitlesView moduleId="subtitles" />);
    handOff(["/in/long.srt"]);
    await screen.findByRole("list", { name: "Subtitles" });
    await waitFor(() => expect(screen.getAllByTestId("cue-row").length).toBeGreaterThan(0));
    expect(screen.getAllByTestId("cue-row").length).toBeLessThan(60);
  });

  it("confirms before replacing unsaved work", async () => {
    const user = userEvent.setup();
    await openSubtitleFile(user);
    await user.type(screen.getByLabelText("Subtitle 1 text"), "!");
    handOff(["/in/other.srt"]);
    expect(await screen.findByText("Discard unsaved changes?")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("before any cues shows the video, the Transcription summary and a Generate button", async () => {
    render(<SubtitlesView moduleId="subtitles" />);
    handOff(["/in/talk.mp4"]);
    await screen.findByText("talk.mp4");
    expect(await screen.findByTestId("player")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate subtitles" })).toBeTruthy();
    expect(screen.getByText("Small · Auto-detect")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Use a subtitle file/ }).length).toBeGreaterThan(0);
    // No cue list yet.
    expect(screen.queryByRole("list", { name: "Subtitles" })).toBeNull();
  });

  it("generates from speech (Transcription panel) and opens the result in the cue list", async () => {
    const user = userEvent.setup();
    render(<SubtitlesView moduleId="subtitles" />);
    handOff(["/in/talk.mp4"]);
    await screen.findByText("talk.mp4");

    // Subtitle tracks inside the video are in the Source panel; picture-based ones can't be used.
    const source = await openPanel(user, "talk.mp4", "Source");
    expect(await within(source).findByRole("button", { name: "Use this track" })).toBeTruthy();
    expect(within(source).getByText(/can't be edited/)).toBeTruthy();

    // The speech block and the text-splitting options are in the Transcription panel.
    const panel = await openPanel(user, "Transcription");
    expect(within(panel).getAllByLabelText("Characters per line").length).toBeGreaterThan(0);
    await user.click(within(panel).getByRole("radio", { name: "1" }));
    await user.click(within(panel).getByRole("radio", { name: "2" }));
    enqueue.mockResolvedValue([job({ id: "g1" })]);
    await user.selectOptions(within(panel).getByLabelText("Model"), "turbo");
    await user.click(within(panel).getByRole("button", { name: "Generate subtitles" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    const [inputs, opts] = enqueue.mock.calls[0] as [string[], { action: string; model: string; formats: string[] }];
    expect(inputs).toEqual(["/in/talk.mp4"]);
    expect(opts).toMatchObject({ action: "generate", model: "turbo", formats: ["srt"] });

    act(() => useJobs.getState().upsert(job({ id: "g1", status: JobStatus.JobRunning, progress: 0.4, message: "Transcribing" }) as never));
    expect((await screen.findAllByText("Transcribing")).length).toBeGreaterThan(0);

    load.mockResolvedValue(CUES);
    act(() =>
      useJobs.getState().upsert(
        job({
          id: "g1",
          status: JobStatus.JobDone,
          progress: 1,
          resultJson: JSON.stringify({ action: "generate", language: "en", cues: 3, outputs: ["/o/Subtitles/talk.srt"] }),
        }) as never,
      ),
    );
    await screen.findByLabelText("Subtitle 3 text");
    expect(load).toHaveBeenCalledWith("/o/Subtitles/talk.srt");
    expect(await screen.findByTestId("player")).toBeTruthy();
  });

  it("shows a failed generation with its hint", async () => {
    const user = userEvent.setup();
    render(<SubtitlesView moduleId="subtitles" />);
    handOff(["/in/talk.mp4"]);
    await screen.findByText("talk.mp4");
    enqueue.mockRejectedValue({ code: "dependency_missing", message: "The AI engine isn't installed", hint: "Install it from Settings" });
    await user.click(screen.getByRole("button", { name: "Generate subtitles" }));
    expect(await screen.findByText("The AI engine isn't installed")).toBeTruthy();
    expect(screen.getByText("Install it from Settings")).toBeTruthy();
  });

  it("uses a subtitle track inside the video", async () => {
    const user = userEvent.setup();
    render(<SubtitlesView moduleId="subtitles" />);
    handOff(["/in/talk.mp4"]);
    await screen.findByText("talk.mp4");
    const source = await openPanel(user, "talk.mp4", "Source");
    enqueue.mockResolvedValue([job({ id: "x1" })]);
    await user.click(await within(source).findByRole("button", { name: "Use this track" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalled());
    expect((enqueue.mock.calls[0] as [string[], { action: string; streamIndex: number }])[1]).toMatchObject({ action: "extract", streamIndex: 2 });
  });

  it("explains how to translate when Local Chat has no model", async () => {
    const user = userEvent.setup();
    translatorStatus.mockResolvedValue({ ready: false, model: "", error: "No model is downloaded" });
    await openSubtitleFile(user);
    const panel = await openPanel(user, "Translate");
    expect(await within(panel).findByText("Download a model in Local Chat to translate")).toBeTruthy();
    expect(within(panel).getByText("No model is downloaded")).toBeTruthy();
    expect((within(panel).getByRole("button", { name: /^Translate 3 subtitles/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(panel).getByRole("button", { name: "Open Local Chat" }));
    expect(useUI.getState().view).toBe("llm-chat");
  });

  it("translates and opens the result as a second track", async () => {
    const user = userEvent.setup();
    await openSubtitleFile(user);
    const panel = await openPanel(user, "Translate");
    await within(panel).findByText(/Translating with Qwen 3/);
    await user.selectOptions(within(panel).getByLabelText("Target language"), "es");
    enqueue.mockResolvedValue([job({ id: "t1" })]);
    await user.click(within(panel).getByRole("button", { name: /^Translate 3 subtitles/ }));
    await waitFor(() => expect(enqueue).toHaveBeenCalled());
    const [, opts] = enqueue.mock.calls[0] as [string[], { action: string; targetLanguage: string; cues: unknown[] }];
    expect(opts).toMatchObject({ action: "translate", targetLanguage: "es" });
    expect(opts.cues).toHaveLength(3);

    load.mockResolvedValue([{ startMs: 0, endMs: 2000, text: "Hola" }]);
    act(() =>
      useJobs.getState().upsert(
        job({
          id: "t1",
          status: JobStatus.JobDone,
          progress: 1,
          resultJson: JSON.stringify({ action: "translate", language: "es", cues: 1, outputs: ["/o/Subtitles/talk.es.srt"] }),
        }) as never,
      ),
    );
    await screen.findByRole("tab", { name: /Spanish/ });
    expect((screen.getByLabelText("Subtitle 1 text") as HTMLTextAreaElement).value).toBe("Hola");
    await user.click(screen.getByRole("tab", { name: /Original/ }));
    expect((screen.getByLabelText("Subtitle 1 text") as HTMLTextAreaElement).value).toBe("Hello");
  });

  it("asks for the video before burning or embedding", async () => {
    const user = userEvent.setup();
    await openSubtitleFile(user);
    const panel = await openPanel(user, "Export");
    expect(within(panel).getAllByRole("button", { name: "Pick the video" })).toHaveLength(2);
    expect(within(panel).getByRole("button", { name: /Save SRT/ })).toBeTruthy();
  });

  it("burns with the chosen style (Style panel) and embeds with a track language (Export panel)", async () => {
    const user = userEvent.setup();
    render(<SubtitlesView moduleId="subtitles" />);
    handOff(["/in/talk.mp4"]);
    await screen.findByText("talk.mp4");
    load.mockResolvedValue(CUES);
    pickWith.mockResolvedValue(["/in/talk.srt"]);
    await user.click(screen.getAllByRole("button", { name: /Use a subtitle file/ })[0]!);
    await screen.findByLabelText("Subtitle 1 text");

    const style = await openPanel(user, "Style");
    await user.click(await within(style).findByRole("radio", { name: /Boxed/ }));
    await user.click(within(style).getByRole("radio", { name: "Large" }));

    const exportPanel = await openPanel(user, "Export");
    enqueue.mockResolvedValue([job({ id: "b1" })]);
    await user.click(within(exportPanel).getByRole("button", { name: "Burn into the video" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    const [binputs, bopts] = enqueue.mock.calls[0] as [string[], Record<string, unknown>];
    expect(binputs).toEqual(["/in/talk.mp4"]);
    expect(bopts).toMatchObject({ action: "burn", style: "boxed", size: "l", position: "bottom" });

    await user.selectOptions(within(exportPanel).getByLabelText("Track language"), "es");
    enqueue.mockResolvedValue([job({ id: "e1" })]);
    // Wait for the burn job to finish so the buttons unlock.
    act(() => useJobs.getState().upsert(job({ id: "b1", status: JobStatus.JobDone, progress: 1, resultJson: JSON.stringify({ outputs: ["/o/Subtitles/talk (subtitled).mp4"] }) }) as never));
    await user.click(await within(exportPanel).findByRole("button", { name: "Add subtitle track" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
    expect((enqueue.mock.calls[1] as [string[], Record<string, unknown>])[1]).toMatchObject({ action: "embed", trackLanguage: "es" });
  });

  it("saves in both formats chosen in the Export panel", async () => {
    const user = userEvent.setup();
    await openSubtitleFile(user);
    const panel = await openPanel(user, "Export");
    await user.click(within(panel).getByRole("button", { name: "VTT" }));
    enqueue.mockResolvedValue([job({ id: "s3" })]);
    await user.click(within(panel).getByRole("button", { name: "Save SRT + VTT" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalled());
    expect((enqueue.mock.calls[0] as [string[], { formats: string[] }])[1].formats).toEqual(["srt", "vtt"]);
  });

  it("copies a result path through copyText", async () => {
    const user = userEvent.setup();
    await openSubtitleFile(user);
    const panel = await openPanel(user, "Export");
    enqueue.mockResolvedValue([job({ id: "s2" })]);
    await user.click(within(panel).getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(enqueue).toHaveBeenCalled());
    act(() =>
      useJobs.getState().upsert(
        job({ id: "s2", status: JobStatus.JobDone, progress: 1, resultJson: JSON.stringify({ outputs: ["/o/Subtitles/talk.srt"] }) }) as never,
      ),
    );
    const card = await screen.findByLabelText("Result");
    await user.click(within(card).getByRole("button", { name: "Copy path" }));
    expect(copy).toHaveBeenCalledWith("/o/Subtitles/talk.srt");
  });
});

function desc(id: string, name: string): Descriptor {
  return { id, name, icon: "box", status: ModuleStatus.StatusReady, accepts: { extensions: [], urls: false, any: false } } as unknown as Descriptor;
}

describe("Trim first", () => {
  beforeEach(() => {
    enqueue.mockReset();
    load.mockReset();
    open.mockReset();
    open.mockResolvedValue(VIDEO_SOURCE);
    useJobs.setState({ byId: {} });
    useUI.setState({ handoff: null, view: "subtitles" });
    useSubtitles.setState(initialData());
    useModules.getState().setAll([desc("trimmer", "Trimmer"), desc("subtitles", "Subtitles")]);
  });

  function FakeTrimmer() {
    // The embed context carries the handoff and Use; the fake just echoes it.
    return <TrimmerStub />;
  }

  it("opens the Trimmer with the source and Use makes the cut the new source", async () => {
    registerToolViews({ trimmer: FakeTrimmer });
    const user = userEvent.setup();
    render(<SubtitlesView moduleId="subtitles" />);
    handOff(["/in/talk.mp4"]);
    await screen.findByText("talk.mp4");
    const source = await openPanel(user, "talk.mp4", "Source");
    await user.click(within(source).getByRole("button", { name: /Trim first/ }));
    expect(await screen.findByText("trimmer for /in/talk.mp4")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Use this cut" }));
    await waitFor(() => expect(useSubtitles.getState().mediaPath).toBe("/in/cut.mp4"));
    expect((await screen.findAllByText("cut.mp4")).length).toBeGreaterThan(0);
  });

  it("asks before clearing the cues when the cut replaces the source", async () => {
    registerToolViews({ trimmer: FakeTrimmer });
    const user = userEvent.setup();
    render(<SubtitlesView moduleId="subtitles" />);
    load.mockResolvedValue(CUES);
    handOff(["/in/talk.mp4"]);
    await screen.findByText("talk.mp4");
    handOff(["/in/talk.srt"]);
    await screen.findByLabelText("Subtitle 1 text");
    const source = await openPanel(user, "talk.mp4", "Source");
    await user.click(within(source).getByRole("button", { name: /Trim first/ }));
    await user.click(await screen.findByRole("button", { name: "Use this cut" }));
    expect(await screen.findByText("Use the trimmed video?")).toBeTruthy();
    expect(useSubtitles.getState().mediaPath).toBe("/in/talk.mp4");
    await user.click(screen.getByRole("button", { name: "Use the cut" }));
    await waitFor(() => expect(useSubtitles.getState().mediaPath).toBe("/in/cut.mp4"));
    expect(useSubtitles.getState().editor.tabs).toHaveLength(0);
  });
});

import { useEmbed } from "@/lib/embed";

function TrimmerStub() {
  const e = useEmbed();
  return (
    <div>
      <p>trimmer for {e?.handoff.inputs.join(",")}</p>
      <button type="button" onClick={() => e?.onUse?.(["/in/cut.mp4"])}>
        {e?.useLabel}
      </button>
    </div>
  );
}

describe("Subtitles from the Library", () => {
  beforeEach(() => {
    enqueue.mockReset();
    load.mockReset();
    open.mockReset();
    open.mockResolvedValue(VIDEO_SOURCE);
    libPick.mockReset();
    libPick.mockResolvedValue([]);
    useJobs.setState({ byId: {} });
    useUI.setState({ handoff: null, view: "subtitles" });
    useSubtitles.setState(initialData());
  });

  it("Video from Library… makes the pick the media, with video and audio extensions only", async () => {
    libPick.mockResolvedValue(["/lib/Videos/talk.mp4"]);
    render(<SubtitlesView moduleId="subtitles" />);
    await userEvent.click(screen.getByRole("button", { name: "Video from Library…" }));
    await waitFor(() => expect(useSubtitles.getState().mediaPath).toBe("/lib/Videos/talk.mp4"));
    expect(libPick).toHaveBeenCalledWith(expect.objectContaining({ multiple: false }));
    const exts = (libPick.mock.calls[0]?.[0] as { exts: string[] | null }).exts ?? [];
    expect(exts).not.toContain(".srt");
  });

  it("Subtitles from Library… opens the .srt like a native pick", async () => {
    load.mockResolvedValue(CUES);
    libPick.mockResolvedValue(["/lib/Transcripts/talk.srt"]);
    render(<SubtitlesView moduleId="subtitles" />);
    await userEvent.click(screen.getByRole("button", { name: "Subtitles from Library…" }));
    await screen.findByLabelText("Subtitle 1 text");
    expect(load).toHaveBeenCalledWith("/lib/Transcripts/talk.srt");
    expect(libPick).toHaveBeenCalledWith(expect.objectContaining({ exts: [".srt", ".vtt"], multiple: false }));
  });
});
