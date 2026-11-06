import { act, render, screen, waitFor, within } from "@testing-library/react";
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

vi.mock("@/blocks/visuals/designer/VisualDesigner", () => ({
  VisualDesigner: (p: { show: { name: string }; onChange(s: unknown): void; text: { overlay: (rect: unknown, ms: number) => unknown } | string; mode: string; onSelect?: unknown; onPlayhead?: unknown }) => (
    <div data-testid="designer" data-mode={p.mode} data-text={typeof p.text === "string" ? p.text : "overlay"} data-own-state={p.onSelect && p.onPlayhead ? "yes" : "no"}>
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
import { initialData, useSubtitles } from "./store";

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

type User = ReturnType<typeof userEvent.setup>;

/** Opens the workspace on a file with two cues loaded. */
async function toWorkspace(user: User, file: string, source: unknown) {
  open.mockResolvedValue(source);
  render(<SubtitlesView moduleId="subtitles" />);
  act(() => useUI.getState().handOff({ moduleId: "subtitles", inputs: [file] }));
  await screen.findByText(file.split("/").pop() as string);
  load.mockResolvedValue(CUES);
  pickWith.mockResolvedValue(["/in/talk.srt"]);
  await user.click(screen.getAllByRole("button", { name: /Use a subtitle file/ })[0]!);
  await screen.findByLabelText("Subtitle 1 text");
  // Wait for the file to be read (audio or video decides what the Style panel offers).
  await waitFor(() => expect(useSubtitles.getState().media.status).toBe("ready"));
}

async function openPanel(user: User, name: string) {
  await user.click(screen.getAllByRole("button", { name: new RegExp(`^${name}`) })[0]!);
  return screen.findByRole("dialog", { name });
}

function lastBurn(): Record<string, unknown> {
  const calls = enqueue.mock.calls;
  return (calls[calls.length - 1] as [string[], Record<string, unknown>])[1];
}

describe("Subtitles visuals (Style and Export panels)", () => {
  beforeEach(() => {
    enqueue.mockReset();
    load.mockReset();
    open.mockReset();
    pickWith.mockReset();
    enqueue.mockResolvedValue([job({ id: "b1" })]);
    useJobs.setState({ byId: {} });
    useUI.setState({ handoff: null, view: "subtitles" });
    useSubtitles.setState(initialData());
  });

  it("makes a video from audio with the Visualizer as the default background", async () => {
    const user = userEvent.setup();
    await toWorkspace(user, "/in/talk.mp3", AUDIO);

    const style = await openPanel(user, "Style");
    expect(within(style).getByTestId("picker").getAttribute("data-mode")).toBe("background");
    expect(within(style).getByRole("switch", { name: "Separate instruments" })).toBeTruthy();
    expect(within(style).getByRole("radio", { name: "Visualizer" }).getAttribute("aria-checked")).toBe("true");
    await user.click(within(style).getByRole("radio", { name: "9:16" }));
    await user.click(within(style).getByRole("radio", { name: "720p" }));

    const exp = await openPanel(user, "Export");
    expect(within(exp).getByRole("heading", { name: "Make a video" })).toBeTruthy();
    const make = within(exp).getByRole("button", { name: "Make a video" }) as HTMLButtonElement;
    expect(make.disabled).toBe(false);
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
    await toWorkspace(user, "/in/talk.mp3", AUDIO);
    const style = await openPanel(user, "Style");
    await user.click(await within(style).findByRole("radio", { name: "Colour" }));
    expect(within(style).queryByTestId("picker")).toBeNull();
    const exp = await openPanel(user, "Export");
    await user.click(within(exp).getByRole("button", { name: "Make a video" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(lastBurn()).toMatchObject({ background: "color", visuals: null });
  });

  it("needs an image before an image background can be made", async () => {
    const user = userEvent.setup();
    await toWorkspace(user, "/in/talk.mp3", AUDIO);
    const style = await openPanel(user, "Style");
    await user.click(await within(style).findByRole("radio", { name: "Image" }));
    pickWith.mockResolvedValue(["/in/bg.png"]);
    let exp = await openPanel(user, "Export");
    expect((within(exp).getByRole("button", { name: "Make a video" }) as HTMLButtonElement).disabled).toBe(true);
    const again = await openPanel(user, "Style");
    await user.click(within(again).getByRole("button", { name: "Choose an image" }));
    await waitFor(() => expect(useSubtitles.getState().prefs.backgroundPath).toBe("/in/bg.png"));
    exp = await openPanel(user, "Export");
    await waitFor(() => expect((within(exp).getByRole("button", { name: "Make a video" }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(within(exp).getByRole("button", { name: "Make a video" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(lastBurn()).toMatchObject({ background: "image", backgroundPath: "/in/bg.png", visuals: null });
  });

  it("offers Visuals for a video, None by default", async () => {
    const user = userEvent.setup();
    await toWorkspace(user, "/in/talk.mp4", VIDEO);
    const style = await openPanel(user, "Style");
    expect(await within(style).findByRole("radio", { name: "None" })).toBeTruthy();
    expect(within(style).getByRole("radio", { name: "None" }).getAttribute("aria-checked")).toBe("true");
    expect(within(style).queryByTestId("picker")).toBeNull();
    const exp = await openPanel(user, "Export");
    expect(within(exp).getByRole("heading", { name: "Burn into the video" })).toBeTruthy();
    await user.click(within(exp).getByRole("button", { name: "Burn into the video" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(lastBurn()).toMatchObject({ action: "burn", visuals: null });
  });

  it("adds visuals over a video through the overlay picker", async () => {
    const user = userEvent.setup();
    await toWorkspace(user, "/in/talk.mp4", VIDEO);
    const style = await openPanel(user, "Style");
    await user.click(await within(style).findByRole("radio", { name: "Add visuals over the video" }));
    expect(within(style).getByTestId("picker").getAttribute("data-mode")).toBe("overlay");
    const exp = await openPanel(user, "Export");
    await user.click(within(exp).getByRole("button", { name: "Burn into the video" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect((lastBurn().visuals as { showJson: string }).showJson.length).toBeGreaterThan(10);
  });

  it("keeps the design when the designer sheet is closed with Done (with Subtitles' own selection state)", async () => {
    const user = userEvent.setup();
    await toWorkspace(user, "/in/talk.mp3", AUDIO);
    const style = await openPanel(user, "Style");
    await user.click(await within(style).findByRole("button", { name: "Open the full designer" }));
    expect(await screen.findByRole("dialog", { name: "Visual designer" })).toBeTruthy();
    expect(screen.getByTestId("designer").getAttribute("data-text")).toBe("overlay");
    expect(screen.getByTestId("designer").getAttribute("data-own-state")).toBe("yes");
    await user.click(screen.getByRole("button", { name: "Edit the design" }));
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Visual designer" })).toBeNull();

    const exp = await openPanel(user, "Export");
    await user.click(within(exp).getByRole("button", { name: "Make a video" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect((lastBurn().visuals as { showJson: string }).showJson).toContain('"name":"Edited"');
  });

  it("asks before Esc discards design changes", async () => {
    const user = userEvent.setup();
    await toWorkspace(user, "/in/talk.mp3", AUDIO);
    let style = await openPanel(user, "Style");
    await user.click(await within(style).findByRole("button", { name: "Open the full designer" }));

    // Nothing changed yet: Esc just closes.
    await screen.findByRole("dialog", { name: "Visual designer" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Visual designer" })).toBeNull();

    style = await openPanel(user, "Style");
    await user.click(within(style).getByRole("button", { name: "Open the full designer" }));
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

    const exp = await openPanel(user, "Export");
    await user.click(within(exp).getByRole("button", { name: "Make a video" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect((lastBurn().visuals as { showJson: string }).showJson).not.toContain('"name":"Edited"');
  });

  it("hands the cues to the Visualizer", async () => {
    const user = userEvent.setup();
    await toWorkspace(user, "/in/talk.mp3", AUDIO);
    const style = await openPanel(user, "Style");
    await user.click(await within(style).findByRole("button", { name: "Make it fully reactive in Visualizer" }));
    const h = useUI.getState().handoff;
    expect(h).toMatchObject({ moduleId: "visualizer", inputs: ["/in/talk.mp3"], seed: { kind: "timed-text", from: "subtitles", overlay: false } });
    expect(h?.seed?.lines).toHaveLength(2);
    expect(h?.seed?.lines[0]?.words?.[0]?.text).toBe("Hello");
  });

  it("hands over a video with the overlay flag", async () => {
    const user = userEvent.setup();
    await toWorkspace(user, "/in/talk.mp4", VIDEO);
    const style = await openPanel(user, "Style");
    await user.click(await within(style).findByRole("radio", { name: "Add visuals over the video" }));
    await user.click(within(style).getByRole("button", { name: "Make it fully reactive in Visualizer" }));
    expect(useUI.getState().handoff?.seed?.overlay).toBe(true);
  });
});
