import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  state: {} as Record<string, string>,
  set: vi.fn(),
  stat: vi.fn(),
  analysisFor: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    SettingsService: {
      ModuleState: async (k: string) => h.state[k] ?? "",
      SetModuleState: (k: string, v: string) => {
        h.set(k, v);
        h.state[k] = v;
        return Promise.resolve();
      },
    },
    FilesService: { Stat: (...a: unknown[]) => h.stat(...a), PickWith: async () => [], Pick: async () => [] },
    MediaService: {
      Open: async () => ({ url: "/media/t/song", proxy: false, proxyJobId: "", info: { durationMs: 60000, hasCover: false, video: null, tags: {} } }),
      Frame: async () => "",
      Waveform: async () => [],
      URLFor: async (p: string) => `/media/t/${p}`,
    },
    VisualizerService: {
      AnalysisFor: (...a: unknown[]) => h.analysisFor(...a),
      Enqueue: (...a: unknown[]) => h.enqueue(...a),
      Defaults: async () => ({ action: "analyze", analyze: {}, mode: "full" }),
      ChatStatus: async () => ({ model: "", ready: false }),
      MoodReaderReady: async () => true,
    },
    TranscribeService: { Languages: async () => [] },
    PacksService: { InstallFor: async () => ({}), Install: async () => ({ jobs: [], restart: false }) },
    JobsService: { Cancel: async () => undefined },
  };
});

vi.mock("@/viz/analysis", async (orig) => {
  const actual = await orig<typeof import("@/viz/analysis")>();
  return { ...actual, loadAnalysis: async () => (await import("@/viz/fixture")).buildFixture() };
});

// The workspace itself is covered elsewhere; here only that it opens.
vi.mock("./VisualizerWorkspace", () => ({ default: () => <div data-testid="workspace" /> }));

import { ClickInHost } from "@/components";
import { DepSource, DepState, PackComponentKind, PackComponentState, PackState, type DepStatus } from "@/lib/api";
import { setCurrentWindowForTest, parseWindow } from "@/lib/windows";
import { useDeps } from "@/state/deps";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { usePacks } from "@/state/packs";
import { useUI } from "@/state/ui";
import { comp, pack } from "@/views/setup/packFixtures";
import AnalysisStage from "./AnalysisStage";
import { buildLastSource, LAST_SOURCE_KEY, MAX_SOURCE_BYTES, resetRestoreForTest, sanitizeLastSource } from "./restore";
import { DEFAULT_ANALYZE, useVisualizer } from "./store";
import VisualizerView from "./VisualizerView";

const REC = { input: "C:/music/night-drive.mp3", isVideo: false, mode: "full", analyze: { ...DEFAULT_ANALYZE, stems: false, mood: false } };
const REF = { key: "k1", audioJson: "a.json", featuresPath: "f.bin", textJson: "", instrumental: "", summary: { durationMs: 60000, tempo: 120, key: "A", sections: [], hasStems: false, hasWords: false, hasMeaning: false, moodSource: "", language: "", lines: 0, warnings: null } };

const dep = (id: string): DepStatus => ({ id, name: id, purpose: "", state: DepState.DepOK, version: "", path: "", source: DepSource.SourceManaged, required: true, requiredBy: [], recommendedBy: null, installHint: "", error: "" }) as unknown as DepStatus;
const exists = (ok: boolean) => h.stat.mockResolvedValue([{ path: REC.input, name: "n", sizeBytes: 1, exists: ok, isDir: false, kind: "audio" }]);
const saved = () => (h.state[`visualizer`] ? (JSON.parse(h.state["visualizer"]) as Record<string, unknown>) : {});

beforeEach(() => {
  h.state = {};
  h.set.mockClear();
  h.stat.mockReset();
  h.analysisFor.mockReset();
  h.enqueue.mockReset();
  h.analysisFor.mockResolvedValue([REF, false]);
  exists(true);
  useVisualizer.getState().reset();
  resetRestoreForTest();
  useUI.setState({ handoff: null });
  useJobs.setState({ byId: {}, logs: {}, logsLoaded: {} });
  useModules.setState({ byId: { visualizer: { id: "visualizer", requires: ["audio-engine", "ffmpeg", "ffprobe"], accepts: { extensions: [".mp3"] } } } } as unknown as Parameters<typeof useModules.setState>[0]);
  useDeps.getState().setAll([dep("audio-engine"), dep("ffmpeg"), dep("ffprobe")]);
  const K = PackComponentKind.ComponentModel;
  const ok = PackComponentState.ComponentInstalled;
  const p = pack("music", "Music", PackState.PackMissing, [comp("stems-default", ok, 80e6, ["music"], K), comp("whisper-default", ok, 400e6, ["music"], K), comp("mood-reader", ok, 120e6, ["music"], K)], ["visualizer"]);
  usePacks.setState({ list: [p], byId: { music: p }, loaded: true });
});

afterEach(() => {
  cleanup();
  setCurrentWindowForTest(null);
  window.history.replaceState(null, "", "/");
});

describe("Visualizer reopens where you left off", () => {
  it("restores the source and its options when the file still exists, without starting a job (StrictMode-safe)", async () => {
    h.state["visualizer"] = JSON.stringify({ [LAST_SOURCE_KEY]: REC });
    render(
      <StrictMode>
        <VisualizerView moduleId="visualizer" />
      </StrictMode>,
    );
    expect(await screen.findByTestId("workspace")).toBeTruthy();
    const s = useVisualizer.getState();
    expect(s.input).toBe(REC.input);
    expect(s.analyze.stems).toBe(false);
    expect(s.analyze.mood).toBe(false);
    expect(s.restored).toBe(true);
    expect(h.stat).toHaveBeenCalledTimes(1);
    expect(h.analysisFor).toHaveBeenCalledWith(REC.input, false);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("loads the cached analysis when there is one", async () => {
    h.state["visualizer"] = JSON.stringify({ [LAST_SOURCE_KEY]: REC });
    h.analysisFor.mockResolvedValue([REF, true]);
    render(<VisualizerView moduleId="visualizer" />);
    await waitFor(() => expect(useVisualizer.getState().analysis).not.toBeNull());
    expect(useVisualizer.getState().ref?.key).toBe("k1");
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("drops a record whose file is gone", async () => {
    h.state["visualizer"] = JSON.stringify({ [LAST_SOURCE_KEY]: REC });
    exists(false);
    render(<VisualizerView moduleId="visualizer" />);
    await waitFor(() => expect(saved()[LAST_SOURCE_KEY]).toBeNull());
    expect(useVisualizer.getState().input).toBeNull();
    expect(screen.getByText("Drop a song or video")).toBeTruthy();
  });

  it("a handoff wins over the restore and replaces the record", async () => {
    h.state["visualizer"] = JSON.stringify({ [LAST_SOURCE_KEY]: REC });
    useUI.setState({ handoff: { moduleId: "visualizer", inputs: ["C:/other/new.mp3"] } } as never);
    render(<VisualizerView moduleId="visualizer" />);
    await waitFor(() => expect(useVisualizer.getState().input).toBe("C:/other/new.mp3"));
    expect(useVisualizer.getState().restored).toBe(false);
    await waitFor(() => expect((saved()[LAST_SOURCE_KEY] as { input: string }).input).toBe("C:/other/new.mp3"), { timeout: 3000 });
  });

  it("a replica neither restores nor saves", async () => {
    h.state["visualizer"] = JSON.stringify({ [LAST_SOURCE_KEY]: REC });
    setCurrentWindowForTest(parseWindow("?window=part&part=visualizer.preview&key=part:visualizer.preview"));
    useVisualizer.setState({ input: "C:/music/live.mp3" });
    render(<VisualizerView moduleId="visualizer" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900));
    });
    expect(h.stat).not.toHaveBeenCalled();
    expect(useVisualizer.getState().input).toBe("C:/music/live.mp3");
    expect((saved()[LAST_SOURCE_KEY] as { input: string } | undefined)?.input).toBe(REC.input);
  });

  it("saves a chosen source, debounced", async () => {
    useVisualizer.getState().setInput("C:/music/a.mp3", false);
    render(<VisualizerView moduleId="visualizer" />);
    await waitFor(() => expect((saved()[LAST_SOURCE_KEY] as { input: string } | undefined)?.input).toBe("C:/music/a.mp3"), { timeout: 3000 });
  });

  it("?vizfixture=1 skips the restore", async () => {
    window.history.replaceState(null, "", "/?vizfixture=1");
    h.state["visualizer"] = JSON.stringify({ [LAST_SOURCE_KEY]: REC });
    render(<VisualizerView moduleId="visualizer" />);
    await waitFor(() => expect(useVisualizer.getState().input).toBe("fixture-song.mp3"));
    expect(h.stat).not.toHaveBeenCalled();
  });
});

describe("Analysis stage after a restore", () => {
  it("shows Analyze ready and starts only when asked", async () => {
    useVisualizer.getState().setInput(REC.input, false);
    useVisualizer.setState({ restored: true });
    h.enqueue.mockResolvedValue([]);
    render(
      <ClickInHost>
        <AnalysisStage />
      </ClickInHost>,
    );
    const btn = await screen.findByRole("button", { name: "Analyze" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(h.enqueue).not.toHaveBeenCalled();
    await userEvent.click(btn);
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(1));
    expect(useVisualizer.getState().restored).toBe(false);
  });
});

describe("last source records", () => {
  it("sanitises what was stored", () => {
    expect(sanitizeLastSource(null)).toBeNull();
    expect(sanitizeLastSource({ input: "" })).toBeNull();
    const r = sanitizeLastSource({ input: "a.mp3", isVideo: true, mode: "nope", analyze: { stems: "x", mood: false } })!;
    expect(r.mode).toBe("full");
    expect(r.isVideo).toBe(true);
    expect(r.analyze.stems).toBe(DEFAULT_ANALYZE.stems);
    expect(r.analyze.mood).toBe(false);
  });

  it("keeps the record within its cap by dropping the lines", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => ({ startMs: i, endMs: i + 1, text: "a long lyric line to fill the space", words: [] }));
    const rec = buildLastSource({ input: "a.mp3", isVideo: false, mode: "full", analyze: { ...DEFAULT_ANALYZE, lines, words: "given" as never } })!;
    expect(JSON.stringify(rec).length).toBeLessThanOrEqual(MAX_SOURCE_BYTES);
    expect(rec.analyze.lines).toEqual([]);
    expect(buildLastSource({ input: null, isVideo: false, mode: "full", analyze: DEFAULT_ANALYZE })).toBeNull();
  });
});
