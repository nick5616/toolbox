import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  analysisFor: vi.fn(),
  enqueue: vi.fn(),
  cancel: vi.fn(),
  loadAnalysis: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    VisualizerService: {
      AnalysisFor: (...a: unknown[]) => h.analysisFor(...a),
      Defaults: async () => ({ action: "", analyze: {} }),
      Enqueue: (...a: unknown[]) => h.enqueue(...a),
      MoodReaderReady: async () => false,
    },
    MediaService: { URLFor: async (p: string) => `/media/t/${p}` },
    JobsService: { Cancel: (...a: unknown[]) => h.cancel(...a) },
  };
});

vi.mock("@/viz/analysis", async (orig) => {
  const actual = await orig<typeof import("@/viz/analysis")>();
  return { ...actual, loadAnalysis: (...a: unknown[]) => h.loadAnalysis(...a) };
});

import { JobStatus, WordsSource, type AnalyzeOptions } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import { useVisualsAnalysis } from "./useVisualsAnalysis";

const ANALYZE: AnalyzeOptions = { stems: false, saveStems: false, words: WordsSource.WordsNone, language: "", lyricsText: "", lyricsPath: "", lines: null, mood: false, deepRead: false };

function ref(key: string, hasWords = false) {
  return {
    key,
    audioJson: `${key}.audio.json`,
    featuresPath: `${key}.features.bin`,
    textJson: hasWords ? `${key}.text.json` : "",
    instrumental: "",
    summary: { durationMs: 1000, tempo: 120, key: "C", sections: [], hasStems: false, hasWords, hasMeaning: false, moodSource: "", language: "", lines: 0, warnings: [] },
  };
}

function job(over: Record<string, unknown>) {
  return { id: "j1", moduleId: "visualizer", title: "", status: JobStatus.JobRunning, progress: 0, message: "", inputs: [], outputs: [], errorCode: "", error: "", errorHint: "", resultJson: "", ...over } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  useJobs.setState({ byId: {} });
  window.history.replaceState({}, "", "/");
  h.loadAnalysis.mockImplementation(async (u: unknown) => ({ urls: u }));
});

describe("useVisualsAnalysis", () => {
  it("reuses a cached analysis without submitting", async () => {
    h.analysisFor.mockResolvedValue([ref("cached"), true]);
    const { result } = renderHook(() => useVisualsAnalysis("/a.mp3", { analyze: ANALYZE, auto: true }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.loadAnalysis).toHaveBeenCalledWith({ audioJsonUrl: "/media/t/cached.audio.json", featuresUrl: "/media/t/cached.features.bin", textJsonUrl: undefined });
    expect(h.analysisFor).toHaveBeenCalledWith("/a.mp3", false);
  });

  it("does not submit when auto is off", async () => {
    h.analysisFor.mockResolvedValue([ref(""), false]);
    const { result } = renderHook(() => useVisualsAnalysis("/a.mp3", { analyze: ANALYZE, auto: false }));
    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("submits an analyze job on a miss, follows it and loads the files", async () => {
    h.analysisFor.mockResolvedValue([ref(""), false]);
    h.enqueue.mockResolvedValue([{ id: "j1" }]);
    const { result } = renderHook(() => useVisualsAnalysis("/b.mp3", { analyze: ANALYZE, auto: true }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(1));
    expect(h.enqueue.mock.calls[0]?.[0]).toEqual(["/b.mp3"]);
    expect((h.enqueue.mock.calls[0]?.[1] as { action: string }).action).toBe("analyze");

    act(() => useJobs.getState().upsert(job({ progress: 0.4, message: "Listening" })));
    await waitFor(() => expect(result.current.status).toBe("running"));
    expect(result.current.progress).toBeCloseTo(0.4);
    expect(result.current.stage).toBe("Listening");

    act(() => useJobs.getState().upsert(job({ status: JobStatus.JobDone, progress: 1, resultJson: JSON.stringify({ analysis: ref("fresh") }) })));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.ref?.key).toBe("fresh");
    expect(result.current.analysis).not.toBeNull();
  });

  it("reports a failed job as an error", async () => {
    h.analysisFor.mockResolvedValue([ref(""), false]);
    h.enqueue.mockResolvedValue([{ id: "j1" }]);
    const { result } = renderHook(() => useVisualsAnalysis("/c.mp3", { analyze: ANALYZE, auto: true }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalled());
    act(() => useJobs.getState().upsert(job({ status: JobStatus.JobFailed, error: "The engine crashed", errorHint: "Try again" })));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error?.message).toBe("The engine crashed");
    expect(result.current.error?.hint).toBe("Try again");
  });

  it("cancels the running job", async () => {
    h.analysisFor.mockResolvedValue([ref(""), false]);
    h.enqueue.mockResolvedValue([{ id: "j1" }]);
    h.cancel.mockResolvedValue(undefined);
    const { result } = renderHook(() => useVisualsAnalysis("/d.mp3", { analyze: ANALYZE, auto: true }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalled());
    await waitFor(() => expect(result.current.status).toBe("running"));
    act(() => result.current.cancel());
    expect(h.cancel).toHaveBeenCalledWith("j1");
  });

  it("re-analyses once when words are wanted and the cached one has none", async () => {
    h.analysisFor.mockResolvedValue([ref("nowords", false), true]);
    h.enqueue.mockResolvedValue([{ id: "j1" }]);
    const words = { ...ANALYZE, words: WordsSource.WordsGiven, lines: [] };
    renderHook(() => useVisualsAnalysis("/e.mp3", { analyze: words, auto: true }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(1));
  });

  it("returns the synthetic analysis with the vizfixture flag", async () => {
    window.history.replaceState({}, "", "/?vizfixture=1");
    const { result } = renderHook(() => useVisualsAnalysis("/f.mp3", { analyze: ANALYZE, auto: true }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.analysis).not.toBeNull();
    expect(h.analysisFor).not.toHaveBeenCalled();
  });
});
