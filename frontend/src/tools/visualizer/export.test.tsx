import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enqueue: vi.fn(),
  can2160: { value: true },
  jpeg: { value: false },
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    VisualizerService: { Enqueue: (...a: unknown[]) => h.enqueue(...a), Fonts: async () => [] },
    JobsService: { Cancel: async () => undefined },
    FilesService: { PickWith: async () => [] },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
  };
});

vi.mock("@/components/media", async (orig) => {
  const actual = await orig<typeof import("@/components/media")>();
  return { ...actual, MediaPlayer: () => <div data-testid="clip" />, useMediaSource: () => ({ status: "idle", retry() {} }) };
});

vi.mock("@/viz/worker/encoder", () => ({
  chooseEncoder: async (w: number) => {
    if (h.jpeg.value) return { kind: "jpeg", label: "jpeg" };
    if (w >= 3840 && !h.can2160.value) return { kind: "jpeg", label: "jpeg" };
    return { kind: "h264", label: "h264-hw", config: {} };
  },
}));

import { VisualizerAction, VisualizerMode, type AnalysisRef, type Job } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import { buildFixture } from "@/viz/fixture";
import { PRESETS, showFromPreset } from "@/viz/presets";
import { DEFAULT_EXPORT, outputSize, sanitizeExport, type ExportPrefs } from "./exportPrefs";
import ExportStep from "./ExportStep";
import { liveSpeed } from "./useVizJob";
import { useVisualizer } from "./store";

const analysis = buildFixture({ durationMs: 40_000 });
const REF: AnalysisRef = {
  key: "k-1",
  audioJson: "",
  featuresPath: "",
  textJson: "",
  instrumental: "",
  summary: { durationMs: 40_000, tempo: 120, key: "A minor", sections: [], hasStems: true, hasWords: true, hasMeaning: true, moodSource: "music", language: "en", lines: 8, warnings: null },
};

function job(over: Partial<Job>): Job {
  return {
    id: "j1", moduleId: "visualizer", title: "t", status: "running" as Job["status"], progress: 0, message: "", inputs: ["C:/song.mp3"], optionsJson: "", errorCode: "" as Job["errorCode"],
    error: "", errorHint: "", attempt: 1, cancelRequested: false, createdAt: 1, startedAt: 1, finishedAt: 0, outputs: [], resultJson: "", ...over,
  };
}

function setup(prefs: ExportPrefs = DEFAULT_EXPORT, store: Partial<ReturnType<typeof useVisualizer.getState>> = {}) {
  useVisualizer.setState({ input: "C:/song.mp3", mode: "full", ref: REF, analysis, show: showFromPreset(PRESETS[0]!), selection: null, playheadMs: 5000, ...store });
  const onPrefs = vi.fn();
  render(<ExportStep prefs={prefs} onPrefs={onPrefs} />);
  return onPrefs;
}

beforeEach(() => {
  h.enqueue.mockReset();
  h.enqueue.mockResolvedValue([job({ status: "queued" as Job["status"] })]);
  h.can2160.value = true;
  h.jpeg.value = false;
  useVisualizer.getState().reset();
  useJobs.setState({ byId: {}, logs: {}, logsLoaded: {} });
});

describe("export rules", () => {
  it("computes output sizes from the short side", () => {
    expect(outputSize("16:9", 1080)).toEqual({ w: 1920, h: 1080 });
    expect(outputSize("9:16", 1080)).toEqual({ w: 1080, h: 1920 });
    expect(outputSize("4:5", 1080)).toEqual({ w: 1080, h: 1350 });
    expect(outputSize("1:1", 720)).toEqual({ w: 720, h: 720 });
  });
  it("sanitizes stored options", () => {
    expect(sanitizeExport({ aspect: "2:1", height: 999, fps: 24, audio: "x" })).toEqual(DEFAULT_EXPORT);
    expect(sanitizeExport({ aspect: "9:16", height: 1440, fps: 60 })).toMatchObject({ aspect: "9:16", height: 1440, fps: 60 });
  });
  it("estimates live speed", () => {
    expect(liveSpeed(0, 0, 10_000, 40, 30)).toBeNull();
    const s = liveSpeed(0.45, 1000, 11_000, 40, 30)!; // half of the frames in 10 s of a 40 s clip
    expect(s.times).toBeCloseTo(2);
    expect(s.fps).toBeCloseTo(60);
  });
});

describe("ExportStep", () => {
  it("offers 2160p only when the encoder supports it", async () => {
    h.can2160.value = false;
    setup();
    const q = screen.getByRole("radiogroup", { name: "Quality" });
    await waitFor(() => expect(q.querySelector('[role="radio"]:disabled')?.textContent).toBe("2160p"));
  });

  it("enables 2160p when supported", async () => {
    setup();
    const radio = await screen.findByRole("radio", { name: "2160p" });
    await waitFor(() => expect((radio as HTMLButtonElement).disabled).toBe(false));
  });

  it("falls back from a 2160p choice the encoder can't do", async () => {
    h.can2160.value = false;
    const onPrefs = setup({ ...DEFAULT_EXPORT, height: 2160 });
    await waitFor(() => expect(onPrefs).toHaveBeenCalledWith({ height: 1440 }));
  });

  it("hides the aspect and frame rate in overlay mode", async () => {
    setup(DEFAULT_EXPORT, { mode: "overlay", isVideo: true });
    expect(screen.queryByRole("radiogroup", { name: "Aspect" })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Frame rate" })).toBeNull();
    expect(screen.queryByLabelText("Background")).toBeNull();
    expect(screen.getByText(/keeps the video's shape/)).toBeTruthy();
  });

  it("shows aspect, frame rate and background in full mode", () => {
    setup();
    expect(screen.getByRole("radiogroup", { name: "Aspect" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Frame rate" })).toBeTruthy();
    expect(screen.getByLabelText("Background")).toBeTruthy();
  });

  it("notes the JPEG fallback", async () => {
    h.jpeg.value = true;
    setup();
    expect(await screen.findByText(/can't encode video in the window/)).toBeTruthy();
  });

  it("renders the video with the design, size and the Song Map selection", async () => {
    setup({ ...DEFAULT_EXPORT, aspect: "9:16", height: 720, fps: 60 }, { selection: { startMs: 4000, endMs: 20000 } });
    await userEvent.click(screen.getByRole("button", { name: "Render video" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(1));
    const [paths, opts] = h.enqueue.mock.calls[0] as [string[], Record<string, unknown>];
    expect(paths).toEqual(["C:/song.mp3"]);
    expect(opts).toMatchObject({ action: VisualizerAction.ActionRender, mode: VisualizerMode.ModeFull, aspect: "9:16", height: 720, fps: 60, startMs: 4000, endMs: 20000, analysisKey: "k-1", audio: "original" });
    expect(JSON.parse(opts.showJson as string).version).toBe(1);
  });

  it("renders a 10 s preview from the playhead", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Render 10 s preview" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(1));
    const opts = (h.enqueue.mock.calls[0] as [string[], Record<string, unknown>])[1];
    expect(opts).toMatchObject({ action: VisualizerAction.ActionPreview, previewStartMs: 5000, startMs: 0, endMs: 0 });
  });

  it("shows progress and the result card", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Render video" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalled());
    useJobs.getState().upsert(job({ progress: 0.4, message: "frame 300" }));
    expect(await screen.findByRole("progressbar", { name: "Rendering the video…" })).toBeTruthy();
    useJobs.getState().upsert(
      job({ status: "done" as Job["status"], progress: 1, outputs: [{ id: "o1", path: "C:/Library/Visualizer/song (visualizer).mp4" } as Job["outputs"] extends (infer O)[] | null ? O : never], resultJson: JSON.stringify({ action: "render", outputs: ["C:/Library/Visualizer/song (visualizer).mp4"], speed: 2.5 }) }),
    );
    expect(await screen.findByText("Your video is ready")).toBeTruthy();
    expect(screen.getByText("song (visualizer).mp4")).toBeTruthy();
  });

  it("blocks rendering an invalid design with the first problem", () => {
    const bad = showFromPreset(PRESETS[0]!);
    bad.reactivity = 9;
    setup(DEFAULT_EXPORT, { show: bad });
    expect(screen.getByText(/couldn't be read: Reactivity must be 0–2/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Render video" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
