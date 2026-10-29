import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const discard = vi.hoisted(() => vi.fn(async () => undefined));
const setState = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
const savedState = vi.hoisted(() => ({ value: "" }));
const picked = vi.hoisted(() => ({ paths: ["/a.wav"] }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    AudioCleanupService: {
      Defaults: async () => ({}),
      Enqueue: (...a: unknown[]) => enqueue(...a),
      DiscardPreviews: () => discard(),
    },
    MediaService: {
      Waveform: async () => [0.1, 0.5, 0.2],
      URLFor: async (p: string) => `/media/tok/${p}`,
      Open: async () => ({ url: "/media/x/a.wav", proxy: false, proxyJobId: "", info: { durationMs: 60000 } }),
    },
    FilesService: {
      Pick: async () => picked.paths,
      Stat: async (p: string[]) => p.map((path) => ({ path, name: path, sizeBytes: 10, exists: true, isDir: false, kind: "audio" })),
    },
    SettingsService: { ModuleState: async () => savedState.value, SetModuleState: (...a: unknown[]) => setState(...a) },
    LibraryService: { Reveal: async () => undefined, Open: async () => undefined, RevealPath: async () => undefined },
  };
});

vi.mock("@/components/media", () => ({
  useMediaSource: (path: string | null) => ({
    status: path ? "ready" : "idle",
    source: path ? { url: "/media/x/a.wav", proxy: false, proxyJobId: "", info: { durationMs: 60000 } } : undefined,
    retry: () => undefined,
  }),
  Waveform: ({ band, onSeek }: { band?: { start: number; end: number }; onSeek?: (f: number) => void }) => (
    <button data-testid="waveform" data-band={band ? `${band.start.toFixed(3)}-${band.end.toFixed(3)}` : ""} onClick={() => onSeek?.(0.5)}>
      wave
    </button>
  ),
  ABToggle: ({ a, b }: { a: { url: string }; b: { url: string } }) => (
    <div data-testid="ab-toggle" data-a={a.url} data-b={b.url} />
  ),
}));

import { useToastStore } from "@/components/toast";
import { CleanupDenoise, CleanupFormat, DepState, JobStatus, PackComponentState, type DepStatus, type Job } from "@/lib/api";
import { useDeps } from "@/state/deps";
import { useJobs, normalizeJob } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { usePacks } from "@/state/packs";
import AudioCleanupView from "./AudioCleanupView";
import {
  DEFAULT_CLEANUP_OPTIONS,
  formatLufs,
  isVideoPath,
  parseFiles,
  parsePreview,
  previewKey,
  previewStartFor,
  previewSummary,
  sanitizeCleanupOptions,
} from "./options";

describe("audio cleanup options", () => {
  it("defaults match the Go defaults", () => {
    expect(DEFAULT_CLEANUP_OPTIONS).toEqual({
      highPass: true,
      hum: "auto",
      denoise: "voice",
      loudness: "podcast",
      format: "same",
      preview: false,
      previewStartMs: 0,
    });
  });

  it("sanitize keeps valid fields and never persists the preview", () => {
    const out = sanitizeCleanupOptions(
      { highPass: false, hum: "60", denoise: "strong", loudness: "nope", format: "flac", preview: true, previewStartMs: 5 },
      DEFAULT_CLEANUP_OPTIONS,
    );
    expect(out).toEqual({ ...DEFAULT_CLEANUP_OPTIONS, highPass: false, hum: "60", denoise: "strong", format: "flac" });
    expect(sanitizeCleanupOptions(null, DEFAULT_CLEANUP_OPTIONS)).toEqual(DEFAULT_CLEANUP_OPTIONS);
    expect(sanitizeCleanupOptions([1], DEFAULT_CLEANUP_OPTIONS)).toEqual(DEFAULT_CLEANUP_OPTIONS);
  });

  it("parses results safely", () => {
    expect(parseFiles("nope")).toEqual([]);
    expect(parseFiles('{"files":[{"input":"/i.wav","output":"/o.wav","lufsBefore":-27.4,"lufsAfter":-16,"humHz":50},{"x":1}]}')).toEqual([
      { input: "/i.wav", output: "/o.wav", lufsBefore: -27.4, lufsAfter: -16, humHz: 50 },
    ]);
    expect(parsePreview('{"files":[]}')).toBeNull();
    const p = parsePreview('{"previewOriginal":"/a.wav","previewCleaned":"/b.wav","lufsBefore":-27.4,"lufsAfter":-16,"humHz":50}');
    expect(p && previewSummary(p)).toBe("−27.4 LUFS → −16.0 LUFS · hum 50 Hz removed");
    expect(formatLufs(-16)).toBe("−16.0");
  });

  it("marks previews stale only when the sound changes", () => {
    const base = previewKey(DEFAULT_CLEANUP_OPTIONS, "/a.wav", 0);
    expect(previewKey({ ...DEFAULT_CLEANUP_OPTIONS, format: CleanupFormat.FormatMP3 }, "/a.wav", 0)).toBe(base);
    expect(previewKey({ ...DEFAULT_CLEANUP_OPTIONS, denoise: CleanupDenoise.DenoiseLight }, "/a.wav", 0)).not.toBe(base);
    expect(previewKey(DEFAULT_CLEANUP_OPTIONS, "/a.wav", 1000)).not.toBe(base);
    expect(previewKey(DEFAULT_CLEANUP_OPTIONS, "/b.wav", 0)).not.toBe(base);
  });

  it("keeps the preview inside the file", () => {
    expect(previewStartFor(0.5, 60000)).toBe(30000);
    expect(previewStartFor(0.99, 60000)).toBe(50000);
    expect(previewStartFor(-1, 60000)).toBe(0);
    expect(previewStartFor(0.5, 8000)).toBe(0);
  });

  it("recognises video paths", () => {
    expect(isVideoPath("C:\\v\\clip.MP4")).toBe(true);
    expect(isVideoPath("/a/b.wav")).toBe(false);
  });
});

function dep(id: string, state: DepState): DepStatus {
  return { id, name: id, state, installHint: "", version: "", path: "", requiredBy: [], recommendedBy: [] } as unknown as DepStatus;
}

function setEnv(opts: { engine: boolean; model: boolean }) {
  useDeps.getState().setAll([
    dep("ffmpeg", DepState.DepOK),
    dep("ffprobe", DepState.DepOK),
    dep("audio-engine", opts.engine ? DepState.DepOK : DepState.DepMissing),
  ]);
  usePacks.getState().setAll([
    {
      id: "speech",
      name: "Speech",
      components: [
        { id: "voice-denoise", state: opts.model ? PackComponentState.ComponentInstalled : PackComponentState.ComponentMissing },
      ],
      unlocks: [{ moduleId: "audio-cleanup", needs: ["ffmpeg", "engine", "voice-denoise"] }],
    },
  ] as never);
}

function previewJob(status: JobStatus, resultJson = ""): Job {
  return {
    id: "pj1",
    moduleId: "audio-cleanup",
    status,
    inputs: ["/a.wav"],
    outputs: [],
    resultJson,
    message: "",
  } as unknown as Job;
}

describe("AudioCleanupView", () => {
  beforeEach(() => {
    enqueue.mockReset();
    discard.mockClear();
    setState.mockClear();
    savedState.value = "";
    picked.paths = ["/a.wav"];
    useToastStore.setState({ toasts: [] });
    useJobs.setState({ byId: {} });
    useModules.setState({
      byId: {
        "audio-cleanup": {
          id: "audio-cleanup",
          name: "Audio Cleanup",
          tagline: "t",
          accepts: { extensions: [".wav", ".mp3", ".mp4"] },
          maxInputs: 50,
          requires: ["ffmpeg", "ffprobe"],
        },
      },
    } as never);
    setEnv({ engine: true, model: true });
  });

  async function addFile() {
    const user = userEvent.setup();
    const view = render(<AudioCleanupView moduleId="audio-cleanup" />);
    await user.click((await screen.findAllByRole("button", { name: /add files/i }))[0]!);
    await screen.findByLabelText("Input files");
    return { user, view };
  }

  it("submits the chosen options for the added files", async () => {
    enqueue.mockResolvedValue([{ id: "j1" }]);
    const { user } = await addFile();
    await user.click(screen.getByRole("radio", { name: "Light" }));
    await user.click(screen.getByRole("radio", { name: "Streaming" }));
    await user.click(screen.getByRole("button", { name: /Clean 1 file/ }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(enqueue).toHaveBeenCalledWith(["/a.wav"], {
      ...DEFAULT_CLEANUP_OPTIONS,
      denoise: "light",
      loudness: "streaming",
      preview: false,
      previewStartMs: 0,
    });
  });

  it("starts a 10 s preview at the clicked position and shows the A/B player", async () => {
    enqueue.mockResolvedValue([{ id: "pj1", moduleId: "audio-cleanup", status: JobStatus.JobQueued, inputs: ["/a.wav"], outputs: [] }]);
    const { user } = await addFile();
    await user.click(screen.getByTestId("waveform")); // fraction 0.5 of 60 s
    expect(screen.getByTestId("waveform").dataset.band).toBe("0.500-0.667");
    await user.click(screen.getByRole("button", { name: /Preview 10 s/ }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(enqueue).toHaveBeenCalledWith(["/a.wav"], { ...DEFAULT_CLEANUP_OPTIONS, preview: true, previewStartMs: 30000 });

    act(() => {
      useJobs.getState().upsert(
        previewJob(
          JobStatus.JobDone,
          '{"files":[],"previewOriginal":"/c/j-a.wav","previewCleaned":"/c/j-b.wav","lufsBefore":-27.4,"lufsAfter":-16,"humHz":50}',
        ),
      );
    });
    const ab = await screen.findByTestId("ab-toggle");
    expect(ab.dataset.a).toBe("/media/tok//c/j-a.wav");
    expect(ab.dataset.b).toBe("/media/tok//c/j-b.wav");
    expect(screen.getByText("−27.4 LUFS → −16.0 LUFS · hum 50 Hz removed")).toBeTruthy();
    expect(screen.queryByText(/Options changed/)).toBeNull();

    await user.click(screen.getByRole("radio", { name: "Strong" }));
    expect(await screen.findByText("Options changed — preview again")).toBeTruthy();
  });

  it("hides the format picker when every input is a video", async () => {
    picked.paths = ["/clip.mp4"];
    await addFile();
    expect(screen.queryByLabelText("Output format")).toBeNull();
  });

  it("shows the format picker for audio inputs", async () => {
    await addFile();
    expect(screen.getByLabelText("Output format")).toBeTruthy();
  });

  it("offers the model install when Voice isolation lacks its model", async () => {
    setEnv({ engine: true, model: false });
    await addFile();
    expect(await screen.findByText("Voice isolation needs its model")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Clean 1 file/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: /Install voice isolation/ })).toBeTruthy();
  });

  it("switches to Strong once when the AI engine isn't installed", async () => {
    setEnv({ engine: false, model: false });
    render(<AudioCleanupView moduleId="audio-cleanup" />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Strong" }).getAttribute("aria-checked")).toBe("true"));
  });

  it("discards previews on unmount", async () => {
    const { view } = await addFile();
    view.unmount();
    expect(discard).toHaveBeenCalled();
  });

  it("lists loudness before and after for finished jobs", async () => {
    const j = normalizeJob({
      id: "j9",
      moduleId: "audio-cleanup",
      status: JobStatus.JobDone,
      inputs: ["/a.wav"],
      outputs: [{ id: "o1", path: "/lib/a (clean).wav" }],
      resultJson: '{"files":[{"input":"/a.wav","output":"/lib/a (clean).wav","lufsBefore":-27.4,"lufsAfter":-16.1,"humHz":60}]}',
    } as unknown as Job);
    useJobs.getState().upsert(j);
    render(<AudioCleanupView moduleId="audio-cleanup" />);
    expect(await screen.findByText("a (clean).wav")).toBeTruthy();
    expect(screen.getByText("−27.4 LUFS")).toBeTruthy();
    expect(screen.getByText("−16.1 LUFS")).toBeTruthy();
    expect(screen.getByText("60 Hz removed")).toBeTruthy();
  });
});
