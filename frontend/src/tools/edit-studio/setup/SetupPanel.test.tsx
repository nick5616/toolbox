import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode, JobStatus, type AnalysisRef, type Job } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import { normalizeProject } from "@/viz/edit/defaults";
import { buildEditFixture, fixtureProject } from "@/viz/edit/fixture";
import { findClip } from "../doc";
import { useEditStudio } from "../store";
import { analysisRefOf } from "./AnalysisPanel";
import { SetupPanel } from "./SetupPanel";

const mocks = vi.hoisted(() => ({
  AnalysisFor: vi.fn(),
  Analyze: vi.fn(),
  Cancel: vi.fn(),
  Languages: vi.fn(),
  Waveform: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => {
  const a = await orig<typeof import("@/lib/api")>();
  return {
    ...a,
    EditStudioService: { ...a.EditStudioService, AnalysisFor: mocks.AnalysisFor, Analyze: mocks.Analyze, Save: vi.fn() },
    JobsService: { ...a.JobsService, Cancel: mocks.Cancel },
    TranscribeService: { ...a.TranscribeService, Languages: mocks.Languages },
    MediaService: { ...a.MediaService, Waveform: mocks.Waveform },
  };
});
vi.mock("../useEditAutosave", () => ({ flushEdit: vi.fn().mockResolvedValue(undefined) }));

const ctxStub = new Proxy(
  {},
  {
    get: (_t, p: string) => (p === "measureText" ? (s: string) => ({ width: s.length * 6 }) : () => undefined),
    set: () => true,
  },
);

const ref = (key: string, hasWords: boolean): AnalysisRef =>
  ({ key, audioJson: "/a.json", featuresPath: "/f.bin", textJson: hasWords ? "/t.json" : "", instrumental: "", summary: { hasWords } }) as unknown as AnalysisRef;

const job = (over: Partial<Job>): Job =>
  ({
    id: "j1",
    moduleId: "edit-studio",
    title: "Analyzing",
    status: JobStatus.JobRunning,
    progress: 0.4,
    message: "Separating instruments",
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
    pipelineRunId: "",
    pipelineStepId: "",
    ...over,
  }) as Job;

function openProject(withAnalysisKey = "") {
  const doc = normalizeProject({ ...fixtureProject(), analysisKey: withAnalysisKey });
  useEditStudio.getState().open("p1", "Edit", doc);
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ctxStub) as never);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  mocks.AnalysisFor.mockResolvedValue([ref("", false), false]);
  mocks.Analyze.mockResolvedValue(job({ status: JobStatus.JobQueued, progress: 0 }));
  mocks.Cancel.mockResolvedValue(undefined);
  mocks.Languages.mockResolvedValue([{ code: "en", name: "English" }]);
  mocks.Waveform.mockResolvedValue([0.2, 0.5, 0.9]);
  openProject();
});
afterEach(() => {
  act(() => {
    useEditStudio.getState().close();
    useJobs.getState().setAll([]);
  });
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("analysisRefOf", () => {
  it("reads the analysis ref from a result", () => {
    expect(analysisRefOf(JSON.stringify({ action: "analyze", analysis: { key: "k1" } }))?.key).toBe("k1");
    expect(analysisRefOf("")).toBeNull();
    expect(analysisRefOf("{bad")).toBeNull();
    expect(analysisRefOf(JSON.stringify({ analysis: null }))).toBeNull();
  });
});

describe("SetupPanel: analysis", () => {
  it("offers an earlier analysis and uses it with no job", async () => {
    mocks.AnalysisFor.mockResolvedValue([ref("old-s1", true), true]);
    render(<SetupPanel />);
    expect(await screen.findByText("This song was analysed before")).toBeTruthy();
    expect(screen.getByText(/has the lyrics/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use it" }));
    expect(useEditStudio.getState().history?.present.analysisKey).toBe("old-s1");
    expect(mocks.Analyze).not.toHaveBeenCalled();
  });

  it("analyzes with the chosen words and follows the job to its result", async () => {
    render(<SetupPanel />);
    fireEvent.click(screen.getByRole("radio", { name: "Detect" }));
    fireEvent.click(await screen.findByRole("button", { name: "Analyze" }));
    await waitFor(() => expect(mocks.Analyze).toHaveBeenCalledTimes(1));
    expect(mocks.Analyze.mock.calls[0]).toEqual(["p1", { song: "/fixture/song.wav", words: "detect", lyricsText: "", language: "" }]);
    expect(await screen.findByRole("progressbar", { name: "Analysis progress" })).toBeTruthy();
    expect(useEditStudio.getState().jobs.analyze).toBe("j1");

    act(() => useJobs.getState().upsert(job({ status: JobStatus.JobRunning, progress: 0.5, message: "Finding the beat" })));
    expect(await screen.findByText("Finding the beat")).toBeTruthy();

    act(() => useJobs.getState().upsert(job({ status: JobStatus.JobDone, progress: 1, resultJson: JSON.stringify({ action: "analyze", analysis: { key: "new-s1" } }) })));
    await waitFor(() => expect(useEditStudio.getState().history?.present.analysisKey).toBe("new-s1"));
    expect(useEditStudio.getState().jobs.analyze).toBeUndefined();
  });

  it("align needs lyrics, then sends them", async () => {
    render(<SetupPanel />);
    fireEvent.click(screen.getByRole("radio", { name: "Use my lyrics" }));
    const analyze = await screen.findByRole("button", { name: "Analyze" });
    expect((analyze as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Your lyrics"), { target: { value: "  la la la  " } });
    expect((analyze as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(analyze);
    await waitFor(() => expect(mocks.Analyze).toHaveBeenCalled());
    expect(mocks.Analyze.mock.calls[0]?.[1]).toMatchObject({ words: "align", lyricsText: "la la la" });
  });

  it("cancels a running job", async () => {
    render(<SetupPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Analyze" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(mocks.Cancel).toHaveBeenCalledWith("j1");
  });

  it("shows a failure with its hint and retries", async () => {
    render(<SetupPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Analyze" }));
    await screen.findByRole("progressbar");
    act(() => useJobs.getState().upsert(job({ status: JobStatus.JobFailed, error: "No AI engine", errorHint: "Install the Music edits pack.", errorCode: ErrorCode.CodeDependencyMissing })));
    expect(await screen.findByText("No AI engine")).toBeTruthy();
    expect(screen.getByText("Install the Music edits pack.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mocks.Analyze).toHaveBeenCalledTimes(2));
  });

  it("shows a submit error", async () => {
    mocks.Analyze.mockRejectedValue({ code: "validation", message: "That file is too short", hint: "Use a longer song." });
    render(<SetupPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Analyze" }));
    expect(await screen.findByText("That file is too short")).toBeTruthy();
  });

  it("says when the saved analysis is gone", () => {
    act(() => {
      useEditStudio.getState().setAnalysis(null, null, "missing");
    });
    render(<SetupPanel />);
    expect(screen.getByText(/isn't available any more/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Analyze" })).toBeTruthy();
  });
});

describe("SetupPanel: range", () => {
  beforeEach(() => {
    act(() => {
      useEditStudio.getState().setAnalysis(null, buildEditFixture(), "ready");
    });
  });

  it("picks a quick range and applies it, keeping clips on the music", () => {
    render(<SetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: "First chorus" }));
    expect((screen.getByLabelText("Start") as HTMLInputElement).value).toBe("0:08.000");
    expect((screen.getByLabelText("End") as HTMLInputElement).value).toBe("0:16.000");
    expect(screen.getByLabelText("Length").textContent).toBe("0:08.000");
    fireEvent.click(screen.getByRole("button", { name: "Use this range" }));
    const p = useEditStudio.getState().history?.present;
    expect(p?.song).toMatchObject({ startMs: 8000, endMs: 16_000 });
    // c1 (0..8 s) ended before the new start and is gone; c2 now starts at 0
    expect(p && findClip(p, "c1")).toBeNull();
    expect(p && findClip(p, "c2")?.clip).toMatchObject({ startMs: 0, endMs: 8000 });
  });

  it("without Keep clips on the music, clips keep their times", () => {
    render(<SetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: "First chorus" }));
    fireEvent.click(screen.getByRole("switch", { name: "Keep clips on the music" }));
    fireEvent.click(screen.getByRole("button", { name: "Use this range" }));
    const p = useEditStudio.getState().history?.present;
    expect(p && findClip(p, "c1")?.clip).toMatchObject({ startMs: 0, endMs: 8000 });
  });

  it("typing a start time fits the range; a bad time is flagged", () => {
    render(<SetupPanel />);
    const start = screen.getByLabelText("Start") as HTMLInputElement;
    fireEvent.change(start, { target: { value: "0:04" } });
    fireEvent.blur(start);
    expect((screen.getByLabelText("Length") as HTMLElement).textContent).toBe("0:20.000");
    fireEvent.change(start, { target: { value: "abc" } });
    fireEvent.blur(start);
    expect(start.getAttribute("aria-invalid")).toBe("true");
  });

  it("quick picks without a matching part are disabled", () => {
    render(<SetupPanel />);
    expect((screen.getByRole("button", { name: "Whole song" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Drop" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
