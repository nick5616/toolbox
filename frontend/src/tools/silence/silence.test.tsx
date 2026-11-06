import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const analyse = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    SilenceService: { Defaults: async () => ({}), Enqueue: (...a: unknown[]) => enqueue(...a), Analyse: (...a: unknown[]) => analyse(...a) },
    MediaService: { Waveform: async () => [0.1, 0.5, 0.2] },
    FilesService: {
      Pick: async () => ["/a.wav"],
      Stat: async (p: string[]) => p.map((path) => ({ path, name: path, sizeBytes: 10, exists: true, isDir: false, kind: "audio" })),
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    LibraryService: { Reveal: async () => undefined, Open: async () => undefined, RevealPath: async () => undefined },
  };
});

vi.mock("@/components/media", () => ({
  Timeline: ({ ranges, durationMs }: { ranges?: Array<{ startMs: number; endMs: number }>; durationMs: number }) => (
    <div data-testid="timeline" data-duration={durationMs} data-ranges={(ranges ?? []).map((r) => `${r.startMs}-${r.endMs}`).join(",")} />
  ),
}));

import { DepState, JobStatus, type DepStatus, type Job } from "@/lib/api";
import { useDeps } from "@/state/deps";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import SilenceView from "./SilenceView";
import { DEFAULT_SILENCE_OPTIONS, analysisSummary, formatSpan, parseCut, removedRanges, sanitizeSilenceOptions } from "./options";

describe("silence options", () => {
  it("defaults match the Go defaults", () => {
    expect(DEFAULT_SILENCE_OPTIONS).toEqual({ thresholdDb: -35, minSilenceMs: 500, paddingMs: 150, crossfadeMs: 15, cutList: true });
  });

  it("sanitize clamps numbers and ignores junk", () => {
    expect(sanitizeSilenceOptions({ thresholdDb: -200, minSilenceMs: 50, paddingMs: 9999, crossfadeMs: "x", cutList: false }, DEFAULT_SILENCE_OPTIONS)).toEqual({
      thresholdDb: -80,
      minSilenceMs: 100,
      paddingMs: 2000,
      crossfadeMs: 15,
      cutList: false,
    });
    expect(sanitizeSilenceOptions(null, DEFAULT_SILENCE_OPTIONS)).toEqual(DEFAULT_SILENCE_OPTIONS);
    expect(sanitizeSilenceOptions([1], DEFAULT_SILENCE_OPTIONS)).toEqual(DEFAULT_SILENCE_OPTIONS);
  });

  it("describes what a cut would do", () => {
    expect(analysisSummary({ durationMs: 600_000, removedMs: 84_000, removed: [{ startMs: 0, endMs: 1 }, { startMs: 2, endMs: 3 }] })).toBe(
      "Would remove 1:24 of 10:00 (14%) in 2 cuts",
    );
    expect(analysisSummary({ durationMs: 5000, removedMs: 0, removed: [] })).toBe("Nothing is silent with these settings");
    expect(formatSpan(8400)).toBe("8.4 s");
    expect(formatSpan(3_723_000)).toBe("1:02:03");
  });

  it("maps ranges and parses results safely", () => {
    expect(removedRanges([{ startMs: 1, endMs: 2 }])).toEqual([{ id: "cut0", startMs: 1, endMs: 2 }]);
    expect(removedRanges(null)).toEqual([]);
    expect(parseCut("nope")).toBeNull();
    expect(parseCut('{"output":"/o.mp4","cutList":"/o.csv","durationMs":10000,"removedMs":4000,"keptMs":6000}')).toEqual({
      output: "/o.mp4",
      cutList: "/o.csv",
      durationMs: 10000,
      removedMs: 4000,
      keptMs: 6000,
    });
  });
});

function dep(id: string): DepStatus {
  return { id, name: id, state: DepState.DepOK, installHint: "", version: "", path: "", requiredBy: [], recommendedBy: [] } as unknown as DepStatus;
}

describe("SilenceView", () => {
  beforeEach(() => {
    enqueue.mockReset();
    analyse.mockReset();
    useJobs.setState({ byId: {} });
    useModules.setState({
      byId: { silence: { id: "silence", name: "Silence Cutter", tagline: "t", accepts: { extensions: [".wav", ".mp4"] }, maxInputs: 200, requires: ["ffmpeg", "ffprobe"] } },
    } as never);
    useDeps.getState().setAll([dep("ffmpeg"), dep("ffprobe")]);
  });

  async function addFile() {
    const user = userEvent.setup();
    render(<SilenceView moduleId="silence" />);
    await user.click((await screen.findAllByRole("button", { name: /add files/i }))[0]!);
    await screen.findByLabelText("Input files");
    return user;
  }

  it("analyses the file and shows how much would be removed", async () => {
    analyse.mockResolvedValue({
      durationMs: 600_000,
      silences: [],
      removed: [{ startMs: 1000, endMs: 5000 }],
      kept: [],
      removedMs: 84_000,
      keptMs: 516_000,
    });
    await addFile();
    expect((await screen.findByTestId("silence-summary", {}, { timeout: 3000 })).textContent).toBe("Would remove 1:24 of 10:00 (14%) in 1 cut");
    expect(analyse).toHaveBeenCalledWith("/a.wav", DEFAULT_SILENCE_OPTIONS);
    expect(screen.getByTestId("timeline").dataset.ranges).toBe("1000-5000");
  });

  it("shows why the analysis failed", async () => {
    analyse.mockRejectedValue({ message: "This file has no sound to measure" });
    await addFile();
    expect((await screen.findByRole("alert", {}, { timeout: 3000 })).textContent).toBe("This file has no sound to measure");
  });

  it("blocks the run when nothing is silent, and submits otherwise", async () => {
    analyse.mockResolvedValue({ durationMs: 5000, silences: [], removed: [], kept: [], removedMs: 0, keptMs: 5000 });
    await addFile();
    expect((await screen.findByTestId("silence-summary", {}, { timeout: 3000 })).textContent).toBe("Nothing is silent with these settings");
    expect((screen.getByRole("button", { name: /Cut 1 file/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("submits the chosen options", async () => {
    analyse.mockResolvedValue({ durationMs: 5000, silences: [], removed: [{ startMs: 0, endMs: 1000 }], kept: [], removedMs: 1000, keptMs: 4000 });
    enqueue.mockResolvedValue([{ id: "j1" }]);
    const user = await addFile();
    await screen.findByTestId("silence-summary", {}, { timeout: 3000 });
    await user.click(screen.getByRole("button", { name: /Cut 1 file/ }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(enqueue).toHaveBeenCalledWith(["/a.wav"], DEFAULT_SILENCE_OPTIONS);
  });

  it("lists finished cuts", async () => {
    analyse.mockResolvedValue({ durationMs: 5000, silences: [], removed: [], kept: [], removedMs: 0, keptMs: 5000 });
    useJobs.getState().upsert({
      id: "j9",
      moduleId: "silence",
      status: JobStatus.JobDone,
      inputs: ["/a.wav"],
      outputs: [{ id: "o1", path: "/out/a (cut).wav", name: "a (cut).wav" }],
      resultJson: '{"output":"/out/a (cut).wav","cutList":"","durationMs":10000,"removedMs":4000,"keptMs":6000}',
      message: "",
    } as unknown as Job);
    render(<SilenceView moduleId="silence" />);
    expect(await screen.findByText("a (cut).wav")).toBeTruthy();
  });
});
