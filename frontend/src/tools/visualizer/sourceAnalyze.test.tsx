import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  open: vi.fn(),
  enqueue: vi.fn(),
  cancel: vi.fn(),
  chatReady: { value: false },
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    MediaService: {
      Open: (...a: unknown[]) => h.open(...a),
      Frame: async () => "/media/t/cover.jpg",
      URLFor: async (p: string) => `/media/t/${p}`,
      Waveform: async () => [],
    },
    FilesService: { PickWith: async () => [], Pick: async () => [] },
    TranscribeService: { Languages: async () => [{ code: "en", name: "English" }] },
    PacksService: { InstallFor: async () => ({}), Install: async () => ({ jobs: [], restart: false }) },
    JobsService: { Cancel: async (...a: unknown[]) => h.cancel(...a) },
    VisualizerService: {
      Defaults: async () => ({ action: "analyze", analyze: {}, mode: "full" }),
      Enqueue: (...a: unknown[]) => h.enqueue(...a),
      ChatStatus: async () => ({ model: "m", ready: h.chatReady.value }),
      MoodReaderReady: async () => true,
    },
  };
});

vi.mock("@/viz/analysis", async (orig) => {
  const actual = await orig<typeof import("@/viz/analysis")>();
  return { ...actual, loadAnalysis: async () => (await import("@/viz/fixture")).buildFixture() };
});

import { DepSource, DepState, JobStatus, PackComponentKind, PackComponentState, PackState, WordsSource, type DepStatus } from "@/lib/api";
import { useDeps } from "@/state/deps";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { usePacks } from "@/state/packs";
import { useUI } from "@/state/ui";
import { comp, pack } from "@/views/setup/packFixtures";
import AnalyzeStep from "./AnalyzeStep";
import SourceStep from "./SourceStep";
import { DEFAULT_ANALYZE, useVisualizer } from "./store";
import { NEW_TRACKER, stageRows, trackMessage, visibleStages } from "./source/logic";

function dep(id: string, state: DepState): DepStatus {
  return { id, name: id, purpose: "", state, version: "", path: "", source: DepSource.SourceManaged, required: true, requiredBy: [], recommendedBy: null, installHint: "", error: "" } as unknown as DepStatus;
}

const info = (video: boolean) => ({
  url: "/media/t/song",
  proxy: false,
  proxyJobId: "",
  info: { durationMs: 185000, hasCover: !video, video: video ? { width: 1920, height: 1080 } : null, tags: { title: "Night Drive", artist: "Neon" } },
});

function setup(deps: DepState = DepState.DepOK, models = PackComponentState.ComponentInstalled) {
  useModules.setState({ byId: { visualizer: { id: "visualizer", requires: ["audio-engine", "ffmpeg", "ffprobe"], accepts: { extensions: [".mp3", ".mp4"] } } } } as unknown as Parameters<typeof useModules.setState>[0]);
  useDeps.getState().setAll([dep("audio-engine", deps), dep("ffmpeg", DepState.DepOK), dep("ffprobe", DepState.DepOK)]);
  const K = PackComponentKind.ComponentModel;
  const p = pack("music", "Music", PackState.PackMissing, [comp("stems-default", models, 80e6, ["music"], K), comp("whisper-default", models, 400e6, ["music"], K), comp("mood-reader", models, 120e6, ["music"], K)], ["visualizer"]);
  usePacks.setState({ list: [p], byId: { music: p }, loaded: true });
}

beforeEach(() => {
  h.open.mockReset();
  h.enqueue.mockReset();
  h.cancel.mockReset();
  h.chatReady.value = false;
  useVisualizer.getState().reset();
  useUI.setState({ handoff: null });
  useJobs.setState({ byId: {}, logs: {}, logsLoaded: {} });
  setup();
});

describe("Source step", () => {
  it("shows the drop zone until a file is chosen", () => {
    render(<SourceStep />);
    expect(screen.getByText("Drop a song or video")).toBeTruthy();
  });

  it("defaults for an audio file: stems on, words none, no video choice", async () => {
    h.open.mockResolvedValue(info(false));
    useVisualizer.getState().setInput("C:/m/song.mp3", false);
    render(<SourceStep />);
    expect(await screen.findByText("Night Drive")).toBeTruthy();
    expect((screen.getByRole("switch", { name: "Separate instruments" }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("radio", { name: "Over the video" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Also save the stems to the Library" }).getAttribute("aria-checked")).toBe("false");
    // Mood needs words.
    expect((screen.getByRole("switch", { name: "Read the mood of the words" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("video: stems off, the video choice drives the mode", async () => {
    h.open.mockResolvedValue(info(true));
    const user = userEvent.setup();
    useVisualizer.getState().setInput("C:/m/clip.mp4", true);
    render(<SourceStep />);
    expect(screen.getByRole("switch", { name: "Separate instruments" }).getAttribute("aria-checked")).toBe("false");
    expect(useVisualizer.getState().mode).toBe("overlay");
    await user.click(await screen.findByRole("radio", { name: "Use only its sound" }));
    expect(useVisualizer.getState().mode).toBe("full");
  });

  it("Words options reveal their inputs and the language", async () => {
    h.open.mockResolvedValue(info(false));
    const user = userEvent.setup();
    useVisualizer.getState().setInput("C:/m/song.mp3", false);
    render(<SourceStep />);
    await user.click(screen.getByRole("radio", { name: "Paste lyrics" }));
    expect(screen.getByRole("textbox", { name: "Lyrics" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Language" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Analyze" }).hasAttribute("disabled")).toBe(true);
    await user.type(screen.getByRole("textbox", { name: "Lyrics" }), "hello");
    expect(screen.getByRole("button", { name: "Analyze" }).hasAttribute("disabled")).toBe(false);
    await user.click(screen.getByRole("radio", { name: "From a file" }));
    expect(screen.queryByRole("combobox", { name: "Language" })).toBeNull();
    await user.click(screen.getByRole("radio", { name: "No words" }));
    expect(useVisualizer.getState().analyze.words).toBe(WordsSource.WordsNone);
  });

  it("deeper reading is disabled without a ready chat model", async () => {
    h.open.mockResolvedValue(info(false));
    useVisualizer.getState().setInput("C:/m/song.mp3", false);
    useVisualizer.getState().setAnalyze({ words: WordsSource.WordsDetect });
    render(<SourceStep />);
    const sw = screen.getByRole("switch", { name: "Deeper reading with Local Chat" }) as HTMLButtonElement;
    await waitFor(() => expect(screen.getByText("Download a model in Local Chat")).toBeTruthy());
    expect(sw.disabled).toBe(true);
  });

  it("DepsGate rows follow the chosen options", async () => {
    setup(DepState.DepMissing, PackComponentState.ComponentMissing);
    h.open.mockResolvedValue(info(false));
    useVisualizer.getState().setInput("C:/m/song.mp3", false);
    const { unmount } = render(<SourceStep />);
    expect(screen.getAllByText("The AI engine isn't installed").length).toBeGreaterThan(0);
    expect(screen.getByText("The instrument separation model isn't downloaded")).toBeTruthy();
    expect(screen.queryByText("The speech model isn't downloaded")).toBeNull();
    expect(screen.queryByText("The mood reader isn't downloaded")).toBeNull();
    act(() => useVisualizer.getState().setAnalyze({ words: WordsSource.WordsDetect, mood: true }));
    expect(await screen.findByText("The speech model isn't downloaded")).toBeTruthy();
    expect(screen.getByText("The mood reader isn't downloaded")).toBeTruthy();
    act(() => useVisualizer.getState().setAnalyze({ stems: false, mood: false }));
    expect(screen.queryByText("The instrument separation model isn't downloaded")).toBeNull();
    expect(screen.queryByText("The mood reader isn't downloaded")).toBeNull();
    unmount();
  });

  it("Analyze moves to the analyze step and clears the old analysis", async () => {
    h.open.mockResolvedValue(info(false));
    const user = userEvent.setup();
    const onAnalyze = vi.fn();
    useVisualizer.getState().setInput("C:/m/song.mp3", false);
    render(<SourceStep onAnalyze={onAnalyze} />);
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    expect(useVisualizer.getState().step).toBe("analyze");
    expect(onAnalyze).toHaveBeenCalled();
  });

  it("the timed-text seed prefills the Words option", async () => {
    h.open.mockResolvedValue(info(false));
    const lines = [{ startMs: 0, endMs: 1000, text: "hi", words: [] }];
    useUI.setState({ handoff: { moduleId: "visualizer", inputs: ["C:/m/song.mp3"], seed: { kind: "timed-text", from: "lyric-video", lines, overlay: false } } } as unknown as Parameters<typeof useUI.setState>[0]);
    render(<SourceStep />);
    expect(await screen.findByRole("radio", { name: "From Lyric Video" })).toBeTruthy();
    const s = useVisualizer.getState();
    expect(s.input).toBe("C:/m/song.mp3");
    expect(s.analyze.words).toBe(WordsSource.WordsGiven);
    expect(s.analyze.lines).toHaveLength(1);
    expect(s.seedFrom).toBe("lyric-video");
    expect(screen.getByRole("radio", { name: "From Lyric Video" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("stage list logic", () => {
  const o = { ...DEFAULT_ANALYZE, words: WordsSource.WordsDetect };
  it("lists only the stages the options run", () => {
    expect(visibleStages(DEFAULT_ANALYZE)).toEqual(["stems", "listen"]);
    expect(visibleStages(o)).toEqual(["stems", "listen", "words", "mood"]);
    expect(visibleStages({ ...o, stems: false, mood: false })).toEqual(["listen", "words"]);
  });
  it("marks unseen earlier stages as from earlier", () => {
    let t = NEW_TRACKER;
    t = trackMessage(t, "Reading the words");
    const rows = stageRows(o, t, "running");
    expect(rows.map((r) => r.state)).toEqual(["cached", "cached", "active", "pending"]);
  });
  it("a saved analysis is all cached", () => {
    const t = trackMessage(NEW_TRACKER, "Using the saved analysis");
    expect(stageRows(o, t, "done").every((r) => r.state === "cached")).toBe(true);
  });
});

describe("Analyze step", () => {
  const job = (over: Record<string, unknown>) => ({ id: "j1", moduleId: "visualizer", status: JobStatus.JobRunning, progress: 0, message: "", inputs: ["C:/m/song.mp3"], outputs: [], ...over });

  it("follows the job through its stages, then shows the result", async () => {
    h.enqueue.mockResolvedValue([job({ status: JobStatus.JobQueued })]);
    useVisualizer.getState().setInput("C:/m/song.mp3", false);
    useVisualizer.getState().setAnalyze({ words: WordsSource.WordsDetect });
    render(<AnalyzeStep />);
    await waitFor(() => expect(h.enqueue).toHaveBeenCalled());
    const [paths, opts] = h.enqueue.mock.calls[0] as [string[], { action: string; analyze: { words: string } }];
    expect(paths).toEqual(["C:/m/song.mp3"]);
    expect(opts.action).toBe("analyze");
    expect(opts.analyze.words).toBe("detect");
    useJobs.getState().upsert(job({ status: JobStatus.JobRunning, progress: 0.5, message: "Analysing the song" }) as never);
    const list = await screen.findByRole("list", { name: "Stages" });
    await waitFor(() => {
      const items = Array.from(list.querySelectorAll("li")).map((li) => li.getAttribute("data-state"));
      expect(items).toEqual(["cached", "active", "pending", "pending"]);
    });
    expect(screen.getByText("✓ from earlier")).toBeTruthy();

    const ref = {
      key: "k",
      audioJson: "a.json",
      featuresPath: "f.bin",
      textJson: "t.json",
      instrumental: "",
      summary: { durationMs: 60000, tempo: 120, key: "A minor", sections: ["intro", "verse"], hasStems: true, hasWords: true, hasMeaning: true, moodSource: "reader", language: "en", lines: 86, warnings: ["Some words were hard to hear"] },
    };
    useJobs.getState().upsert(job({ status: JobStatus.JobDone, progress: 1, message: "Analysis ready", resultJson: JSON.stringify({ action: "analyze", analysis: ref }) }) as never);
    expect(await screen.findByText("120 BPM")).toBeTruthy();
    expect(screen.getByText("A minor")).toBeTruthy();
    expect(screen.getByText("2 sections")).toBeTruthy();
    expect(screen.getByText("4 instruments")).toBeTruthy();
    expect(screen.getByText(/86 lines/)).toBeTruthy();
    expect(screen.getByText("Some words were hard to hear")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Song map" })).toBeTruthy();
    expect(useVisualizer.getState().analysis).not.toBeNull();
  });

  it("shows a failed job and cancels a running one", async () => {
    const user = userEvent.setup();
    h.enqueue.mockResolvedValue([job({})]);
    useVisualizer.getState().setInput("C:/m/song.mp3", false);
    render(<AnalyzeStep />);
    await waitFor(() => expect(h.enqueue).toHaveBeenCalled());
    useJobs.getState().upsert(job({ message: "Separating the instruments" }) as never);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(h.cancel).toHaveBeenCalledWith("j1");
    useJobs.getState().upsert(job({ status: JobStatus.JobFailed, error: "The AI engine isn't installed", errorHint: "Install it" }) as never);
    expect(await screen.findByText("The AI engine isn't installed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("Re-analyze goes back to Source and clears the analysis", async () => {
    const { buildFixture } = await import("@/viz/fixture");
    const user = userEvent.setup();
    useVisualizer.setState({ step: "analyze", input: "C:/m/song.mp3", analysis: buildFixture(), ref: { key: "k", audioJson: "", featuresPath: "", textJson: "", instrumental: "", summary: { durationMs: 1, tempo: 90, key: "C major", sections: [], hasStems: false, hasWords: false, hasMeaning: false, moodSource: "music", language: "", lines: 0, warnings: null } } });
    render(<AnalyzeStep />);
    await user.click(screen.getByRole("button", { name: "Re-analyze with different options" }));
    expect(useVisualizer.getState().step).toBe("source");
    expect(useVisualizer.getState().analysis).toBeNull();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
