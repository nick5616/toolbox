import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const load = vi.hoisted(() => vi.fn());
const translatorStatus = vi.hoisted(() => vi.fn());
const open = vi.hoisted(() => vi.fn());
const pickWith = vi.hoisted(() => vi.fn());
const copy = vi.hoisted(() => vi.fn());

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

// The real player drives a <video>; jsdom can't play, so stand in for it and the timeline.
vi.mock("@/components/media", async (orig) => {
  const actual = await orig<typeof import("@/components/media")>();
  return {
    ...actual,
    MediaPlayer: () => <div data-testid="player" />,
    Timeline: () => <div data-testid="timeline" />,
  };
});

import { JobStatus, type Job } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import { useUI } from "@/state/ui";
import SubtitlesView from "./SubtitlesView";

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

async function openSubtitleFile(user: ReturnType<typeof userEvent.setup>) {
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
  });

  it("starts empty with a drop zone and the two ways in", () => {
    render(<SubtitlesView moduleId="subtitles" />);
    expect(screen.getByText(/Drop a video, an audio file, or an \.srt/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Use a subtitle file/ })).toBeTruthy();
    expect((screen.getByRole("button", { name: /Edit/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Translate/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("loads a dropped subtitle file straight into the editor", async () => {
    const user = userEvent.setup();
    await openSubtitleFile(user);
    expect(load).toHaveBeenCalledWith("/in/talk.srt");
    expect(screen.getAllByTestId("cue-row")).toHaveLength(3);
    expect((screen.getByLabelText("Subtitle 2 text") as HTMLTextAreaElement).value).toBe("World");
    // No video: the player area offers to pick one.
    expect(screen.getByText("No video to preview against")).toBeTruthy();
  });

  it("shows an error when the subtitle file can't be read", async () => {
    load.mockRejectedValue({ code: "validation", message: "Not a subtitle file" });
    render(<SubtitlesView moduleId="subtitles" />);
    handOff(["/in/bad.srt"]);
    expect(await screen.findByText("Not a subtitle file")).toBeTruthy();
    expect(screen.getByText("Couldn't read the subtitles")).toBeTruthy();
  });

  it("edits text, marks the step unsaved, supports undo, and saves with the cues", async () => {
    const user = userEvent.setup();
    await openSubtitleFile(user);
    const text = screen.getByLabelText("Subtitle 2 text");
    await user.clear(text);
    await user.type(text, "Planet");
    expect(screen.getByLabelText("Unsaved changes")).toBeTruthy();

    enqueue.mockResolvedValue([job({ id: "s1" })]);
    await user.click(screen.getByRole("button", { name: /^Save/ }));
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
    expect((screen.getByRole("button", { name: /^Save/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shifts all times from the toolbar", async () => {
    const user = userEvent.setup();
    await openSubtitleFile(user);
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

  it("generates from speech and opens the result in the editor", async () => {
    const user = userEvent.setup();
    render(<SubtitlesView moduleId="subtitles" />);
    handOff(["/in/talk.mp4"]);
    await screen.findByText("talk.mp4");
    // Streams are listed per text track; picture-based ones can't be used.
    expect(await screen.findByRole("button", { name: "Use this track" })).toBeTruthy();
    expect(screen.getByText(/can't be edited/)).toBeTruthy();

    enqueue.mockResolvedValue([job({ id: "g1" })]);
    await user.selectOptions(screen.getByLabelText("Model"), "turbo");
    await user.click(screen.getByRole("button", { name: "Generate subtitles" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    const [inputs, opts] = enqueue.mock.calls[0] as [string[], { action: string; model: string; formats: string[] }];
    expect(inputs).toEqual(["/in/talk.mp4"]);
    expect(opts).toMatchObject({ action: "generate", model: "turbo", formats: ["srt"] });

    act(() => useJobs.getState().upsert(job({ id: "g1", status: JobStatus.JobRunning, progress: 0.4, message: "Transcribing" }) as never));
    expect(await screen.findByText("Transcribing")).toBeTruthy();

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
    await screen.findByRole("button", { name: "Use this track" });
    enqueue.mockResolvedValue([job({ id: "x1" })]);
    await user.click(screen.getByRole("button", { name: "Use this track" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalled());
    expect((enqueue.mock.calls[0] as [string[], { action: string; streamIndex: number }])[1]).toMatchObject({ action: "extract", streamIndex: 2 });
  });

  it("explains how to translate when Local Chat has no model", async () => {
    const user = userEvent.setup();
    translatorStatus.mockResolvedValue({ ready: false, model: "", error: "No model is downloaded" });
    await openSubtitleFile(user);
    await user.click(screen.getByRole("button", { name: /Translate/ }));
    expect(await screen.findByText("Download a model in Local Chat to translate")).toBeTruthy();
    expect(screen.getByText("No model is downloaded")).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Translate 3 subtitles/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Open Local Chat" }));
    expect(useUI.getState().view).toBe("llm-chat");
  });

  it("translates and opens the result as a second tab", async () => {
    const user = userEvent.setup();
    await openSubtitleFile(user);
    await user.click(screen.getByRole("button", { name: /Translate/ }));
    await screen.findByText(/Translating with Qwen 3/);
    await user.selectOptions(screen.getByLabelText("Target language"), "es");
    enqueue.mockResolvedValue([job({ id: "t1" })]);
    await user.click(screen.getByRole("button", { name: /^Translate 3 subtitles/ }));
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
    await user.click(screen.getByRole("button", { name: /Export/ }));
    const pick = await screen.findAllByRole("button", { name: "Pick the video" });
    expect(pick).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Save SRT/ })).toBeTruthy();
  });

  it("burns with the chosen style and embeds with a track language", async () => {
    const user = userEvent.setup();
    render(<SubtitlesView moduleId="subtitles" />);
    handOff(["/in/talk.mp4"]);
    await screen.findByText("talk.mp4");
    load.mockResolvedValue(CUES);
    pickWith.mockResolvedValue(["/in/talk.srt"]);
    await user.click(screen.getAllByRole("button", { name: /Use a subtitle file/ })[0]!);
    await screen.findByLabelText("Subtitle 1 text");
    await user.click(screen.getByRole("button", { name: /Export/ }));

    await user.click(await screen.findByRole("radio", { name: /Boxed/ }));
    await user.click(screen.getByRole("radio", { name: "Large" }));
    enqueue.mockResolvedValue([job({ id: "b1" })]);
    await user.click(screen.getByRole("button", { name: "Burn into the video" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    const [binputs, bopts] = enqueue.mock.calls[0] as [string[], Record<string, unknown>];
    expect(binputs).toEqual(["/in/talk.mp4"]);
    expect(bopts).toMatchObject({ action: "burn", style: "boxed", size: "l", position: "bottom" });

    await user.selectOptions(screen.getByLabelText("Track language"), "es");
    enqueue.mockResolvedValue([job({ id: "e1" })]);
    // Wait for the burn job to finish so the buttons unlock.
    act(() => useJobs.getState().upsert(job({ id: "b1", status: JobStatus.JobDone, progress: 1, resultJson: JSON.stringify({ outputs: ["/o/Subtitles/talk (subtitled).mp4"] }) }) as never));
    await user.click(await screen.findByRole("button", { name: "Add subtitle track" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
    expect((enqueue.mock.calls[1] as [string[], Record<string, unknown>])[1]).toMatchObject({ action: "embed", trackLanguage: "es" });
  });

  it("copies a result path through copyText", async () => {
    const user = userEvent.setup();
    await openSubtitleFile(user);
    enqueue.mockResolvedValue([job({ id: "s2" })]);
    await user.click(screen.getByRole("button", { name: /^Save/ }));
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
