import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const load = vi.hoisted(() => vi.fn());
const open = vi.hoisted(() => vi.fn());
const pickWith = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    SubtitlesService: {
      Enqueue: (...a: unknown[]) => enqueue(...a),
      Load: (...a: unknown[]) => load(...a),
      TranslatorStatus: async () => ({ ready: true, model: "", error: "" }),
      TranslationLanguages: async () => [],
      Styles: async () => [{ id: "classic", label: "Classic" }],
    },
    TranscribeService: { Languages: async () => [] },
    LyricVideoService: { Fonts: async () => ["Arial"] },
    MediaService: {
      Open: (...a: unknown[]) => open(...a),
      Frame: async () => "/media/t/frame.jpg",
      Filmstrip: async () => "/media/t/strip.jpg",
      Waveform: async () => [0.1, 0.5],
      Keyframes: async () => [],
    },
    FilesService: { PickWith: (...a: unknown[]) => pickWith(...a), Pick: async () => [], Stat: async () => [], ImageThumb: async () => "data:image/png;base64,AA==" },
    VisualizerService: { MoodReaderReady: async () => false, AnalysisFor: async () => [null, false], Designs: async () => [] },
    JobsService: { Cancel: async () => undefined },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    LibraryService: { Reveal: async () => undefined, RevealPath: async () => undefined, Open: async () => undefined },
    ClipboardService: { CopyText: async () => undefined },
  };
});

vi.mock("@/components/media", async (orig) => {
  const actual = await orig<typeof import("@/components/media")>();
  return { ...actual, MediaPlayer: () => <div data-testid="player" />, Timeline: () => <div data-testid="timeline" /> };
});

vi.mock("@/components/viz/useVisualsAnalysis", () => ({
  fixtureFlag: () => false,
  loadRef: async () => ({}),
  useVisualsAnalysis: () => ({ status: "ready", progress: 1, stage: "", ref: null, analysis: { fake: true }, error: null, start() {}, cancel() {} }),
}));

vi.mock("@/components/viz", () => ({
  VisualsCanvas: () => <div data-testid="canvas" />,
  useVisualsAnalysis: () => ({ status: "ready", progress: 1, stage: "", ref: null, analysis: { fake: true }, error: null, start() {}, cancel() {} }),
  VisualsPicker: (p: { mode: string; onOpenDesigner?: () => void }) => (
    <div data-testid="picker" data-mode={p.mode}>
      <button type="button" onClick={p.onOpenDesigner}>
        Open the full designer
      </button>
      <label>
        Separate instruments
        <input type="checkbox" role="switch" aria-label="Separate instruments" checked={false} readOnly />
      </label>
    </div>
  ),
}));

vi.mock("@/tools/visualizer/designer/VisualDesigner", () => ({
  VisualDesigner: (p: { show: { name: string }; onChange(s: unknown): void; text: { overlay: (rect: unknown, ms: number) => unknown } | string; mode: string }) => (
    <div data-testid="designer" data-mode={p.mode} data-text={typeof p.text === "string" ? p.text : "overlay"}>
      <button type="button" onClick={() => p.onChange({ ...p.show, name: "Edited" })}>
        Edit the design
      </button>
    </div>
  ),
}));

import { JobStatus, type Job } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import { useUI } from "@/state/ui";
import SubtitlesView from "./SubtitlesView";

const CUES = [
  { startMs: 0, endMs: 2000, text: "Hello", words: [{ startMs: 0, endMs: 2000, text: "Hello" }] },
  { startMs: 2500, endMs: 4000, text: "World" },
];

function job(over: Partial<Job>): Job {
  return {
    id: "j1", moduleId: "subtitles", title: "Subtitles", status: JobStatus.JobQueued, progress: 0, message: "",
    inputs: [], optionsJson: "", errorCode: "", error: "", errorHint: "", attempt: 1, cancelRequested: false,
    createdAt: 1, startedAt: 1, finishedAt: 0, outputs: [], resultJson: "", ...over,
  } as unknown as Job;
}

const INFO = { durationMs: 60000, startMs: 0, container: "mov", sizeBytes: 1, bitRate: 0, audio: [], subtitles: [], hasCover: false, tags: null };
const VIDEO = { url: "/media/t/v.mp4", proxy: false, proxyJobId: "", info: { ...INFO, video: { index: 0, codec: "h264", width: 1920, height: 1080, fps: 30 } } };
const AUDIO = { url: "/media/t/a.mp3", proxy: false, proxyJobId: "", info: { ...INFO, video: null } };

async function toExport(user: ReturnType<typeof userEvent.setup>, file: string, source: unknown) {
  open.mockResolvedValue(source);
  render(<SubtitlesView moduleId="subtitles" />);
  act(() => useUI.getState().handOff({ moduleId: "subtitles", inputs: [file] }));
  await screen.findByText(file.split("/").pop() as string);
  load.mockResolvedValue(CUES);
  pickWith.mockResolvedValue(["/in/talk.srt"]);
  await user.click(screen.getAllByRole("button", { name: /Use a subtitle file/ })[0]!);
  await screen.findByLabelText("Subtitle 1 text");
  await user.click(screen.getByRole("button", { name: /Export/ }));
}

function lastBurn(): Record<string, unknown> {
  const calls = enqueue.mock.calls;
  return (calls[calls.length - 1] as [string[], Record<string, unknown>])[1];
}

describe("Subtitles visuals", () => {
  beforeEach(() => {
    enqueue.mockReset();
    load.mockReset();
    open.mockReset();
    pickWith.mockReset();
    enqueue.mockResolvedValue([job({ id: "b1" })]);
    useJobs.setState({ byId: {} });
    useUI.setState({ handoff: null, view: "subtitles" });
  });

  it("makes a video from audio with the Visualizer as the default background", async () => {
    const user = userEvent.setup();
    await toExport(user, "/in/talk.mp3", AUDIO);

    expect(await screen.findByRole("heading", { name: "Make a video" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Visualizer" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("picker").getAttribute("data-mode")).toBe("background");
    expect(screen.getByRole("switch", { name: "Separate instruments" })).toBeTruthy();
    const make = screen.getByRole("button", { name: "Make a video" }) as HTMLButtonElement;
    expect(make.disabled).toBe(false);

    await user.click(screen.getByRole("radio", { name: "9:16" }));
    await user.click(screen.getByRole("radio", { name: "720p" }));
    await user.click(make);
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    const [inputs, opts] = enqueue.mock.calls[0] as [string[], Record<string, unknown>];
    expect(inputs).toEqual(["/in/talk.mp3"]);
    expect(opts).toMatchObject({ action: "burn", canvas: "9:16", canvasHeight: 720, background: "visualizer" });
    const visuals = opts.visuals as { showJson: string; stems: boolean; useWords: boolean };
    expect(visuals.showJson.length).toBeGreaterThan(10);
    expect(visuals.stems).toBe(false);
  });

  it("sends no visuals for a colour background", async () => {
    const user = userEvent.setup();
    await toExport(user, "/in/talk.mp3", AUDIO);
    await user.click(await screen.findByRole("radio", { name: "Colour" }));
    expect(screen.queryByTestId("picker")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Make a video" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(lastBurn()).toMatchObject({ background: "color", visuals: null });
  });

  it("needs an image before an image background can be made", async () => {
    const user = userEvent.setup();
    await toExport(user, "/in/talk.mp3", AUDIO);
    await user.click(await screen.findByRole("radio", { name: "Image" }));
    expect((screen.getByRole("button", { name: "Make a video" }) as HTMLButtonElement).disabled).toBe(true);
    pickWith.mockResolvedValue(["/in/bg.png"]);
    await user.click(screen.getByRole("button", { name: "Choose an image" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Make a video" }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole("button", { name: "Make a video" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(lastBurn()).toMatchObject({ background: "image", backgroundPath: "/in/bg.png", visuals: null });
  });

  it("offers a Visuals row for a video, None by default", async () => {
    const user = userEvent.setup();
    await toExport(user, "/in/talk.mp4", VIDEO);

    expect(await screen.findByRole("heading", { name: "Burn into the video" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "None" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("picker")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Burn into the video" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(lastBurn()).toMatchObject({ action: "burn", visuals: null });
  });

  it("adds visuals over a video through the overlay picker", async () => {
    const user = userEvent.setup();
    await toExport(user, "/in/talk.mp4", VIDEO);
    await user.click(await screen.findByRole("radio", { name: "Add visuals over the video" }));
    expect(screen.getByTestId("picker").getAttribute("data-mode")).toBe("overlay");
    await user.click(screen.getByRole("button", { name: "Burn into the video" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect((lastBurn().visuals as { showJson: string }).showJson.length).toBeGreaterThan(10);
  });

  it("keeps the design when the designer sheet is closed with Done", async () => {
    const user = userEvent.setup();
    await toExport(user, "/in/talk.mp3", AUDIO);
    await user.click(await screen.findByRole("button", { name: "Open the full designer" }));
    const sheet = await screen.findByRole("dialog", { name: "Visual designer" });
    expect(sheet).toBeTruthy();
    expect(screen.getByTestId("designer").getAttribute("data-text")).toBe("overlay");
    await user.click(screen.getByRole("button", { name: "Edit the design" }));
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Visual designer" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Make a video" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect((lastBurn().visuals as { showJson: string }).showJson).toContain('"name":"Edited"');
  });

  it("asks before Esc discards design changes", async () => {
    const user = userEvent.setup();
    await toExport(user, "/in/talk.mp3", AUDIO);
    await user.click(await screen.findByRole("button", { name: "Open the full designer" }));

    // Nothing changed yet: Esc just closes.
    await screen.findByRole("dialog", { name: "Visual designer" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Visual designer" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Open the full designer" }));
    await user.click(await screen.findByRole("button", { name: "Edit the design" }));
    await user.keyboard("{Escape}");
    expect(await screen.findByText("Discard your design changes?")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Visual designer" })).toBeTruthy();

    // Keep editing, then ask again and discard.
    await user.click(screen.getAllByRole("button", { name: "Cancel" }).at(-1)!); // the confirm dialog's, rendered last
    expect(screen.queryByText("Discard your design changes?")).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("dialog", { name: "Visual designer" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Make a video" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect((lastBurn().visuals as { showJson: string }).showJson).not.toContain('"name":"Edited"');
  });

  it("hands the cues to the Visualizer", async () => {
    const user = userEvent.setup();
    await toExport(user, "/in/talk.mp3", AUDIO);
    await user.click(await screen.findByRole("button", { name: "Make it fully reactive in Visualizer" }));
    const h = useUI.getState().handoff;
    expect(h).toMatchObject({ moduleId: "visualizer", inputs: ["/in/talk.mp3"], seed: { kind: "timed-text", from: "subtitles", overlay: false } });
    expect(h?.seed?.lines).toHaveLength(2);
    expect(h?.seed?.lines[0]?.words?.[0]?.text).toBe("Hello");
  });

  it("hands over a video with the overlay flag", async () => {
    const user = userEvent.setup();
    await toExport(user, "/in/talk.mp4", VIDEO);
    await user.click(await screen.findByRole("radio", { name: "Add visuals over the video" }));
    await user.click(screen.getByRole("button", { name: "Make it fully reactive in Visualizer" }));
    expect(useUI.getState().handoff?.seed?.overlay).toBe(true);
  });
});
