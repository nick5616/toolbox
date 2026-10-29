import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enqueue: vi.fn(),
  open: vi.fn(),
  pickWith: vi.fn(),
  setState: vi.fn(),
  playerMs: { value: 0 },
  played: { value: false },
  emitTime: { current: null as ((ms: number) => void) | null },
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    LyricVideoService: {
      Enqueue: (...a: unknown[]) => h.enqueue(...a),
      Fonts: async () => ["Arial", "Georgia"],
    },
    TranscribeService: { Languages: async () => [{ code: "en", name: "English" }] },
    MediaService: {
      Open: (...a: unknown[]) => h.open(...a),
      Frame: async () => "/media/t/cover.jpg",
      Waveform: async () => [0.1, 0.5],
      URLFor: async () => "/media/t/bg.jpg",
    },
    FilesService: { PickWith: (...a: unknown[]) => h.pickWith(...a), Pick: async () => [] },
    JobsService: { Cancel: async () => undefined },
    SettingsService: { ModuleState: async () => "", SetModuleState: (...a: unknown[]) => h.setState(...a) },
    LibraryService: { Reveal: async () => undefined, RevealPath: async () => undefined, Open: async () => undefined },
    ClipboardService: { CopyText: async () => undefined },
  };
});

vi.mock("@/components/media", async (orig) => {
  const actual = await orig<typeof import("@/components/media")>();
  const React = await import("react");
  return {
    ...actual,
    MediaPlayer: React.forwardRef(function MediaPlayerStub(p: { onTime?: (ms: number) => void }, ref: React.Ref<unknown>) {
      h.emitTime.current = (ms) => {
        h.playerMs.value = ms;
        p.onTime?.(ms);
      };
      React.useImperativeHandle(ref, () => ({
        play() {
          h.played.value = true;
        },
        pause() {
          h.played.value = false;
        },
        toggle() {},
        seek(ms: number) {
          h.playerMs.value = ms;
        },
        step() {},
        currentMs: () => h.playerMs.value,
        playing: () => h.played.value,
      }));
      return <div data-testid="player" />;
    }),
    Timeline: () => <div data-testid="timeline" />,
  };
});

import { DepSource, DepState, JobStatus, type DepStatus, type Job } from "@/lib/api";
import { useDeps } from "@/state/deps";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import LyricVideoView from "./LyricVideoView";

const SONG = {
  url: "/media/t/song.mp3",
  proxy: false,
  proxyJobId: "",
  info: {
    durationMs: 120000,
    startMs: 0,
    container: "mp3",
    sizeBytes: 1,
    bitRate: 0,
    video: null,
    audio: [],
    subtitles: [],
    hasCover: true,
    tags: { title: "Fireflies", ARTIST: "Owl City" },
  },
};

const LINES = [
  {
    startMs: 1000,
    endMs: 3000,
    text: "hello big world",
    words: [
      { startMs: 1000, endMs: 1500, text: "hello" },
      { startMs: 1500, endMs: 2000, text: "big" },
      { startMs: 2000, endMs: 3000, text: "world" },
    ],
  },
  { startMs: 4000, endMs: 6000, text: "second line", words: [] },
  { startMs: 7000, endMs: 8000, text: "third", words: [] },
];

function job(over: Partial<Job>): Job {
  return {
    id: "j1",
    moduleId: "lyric-video",
    title: "Lyric Video",
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

function dep(id: string, state: DepState): DepStatus {
  return {
    id, name: id, purpose: "", state, version: "", path: "", source: DepSource.SourceManaged, required: true,
    requiredBy: [], recommendedBy: null, installHint: "", error: "",
  } as unknown as DepStatus;
}

function handOff(inputs: string[]) {
  act(() => useUI.getState().handOff({ moduleId: "lyric-video", inputs }));
}

function finish(id: string, result: unknown, extra: Partial<Job> = {}) {
  act(() =>
    useJobs.getState().upsert(job({ id, status: JobStatus.JobDone, progress: 1, resultJson: JSON.stringify(result), ...extra }) as never),
  );
}

type User = ReturnType<typeof userEvent.setup>;

async function toLyrics(user: User) {
  render(<LyricVideoView moduleId="lyric-video" />);
  handOff(["/in/song.mp3"]);
  await waitFor(() => expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Fireflies"));
  const next = await screen.findByRole("button", { name: /Next: Lyrics/ });
  await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false));
  await user.click(next);
}

/** Runs "Paste lyrics" and finishes the job with LINES. */
async function withLines(user: User, matched = 0.9) {
  await toLyrics(user);
  await user.type(screen.getByLabelText("Lyrics"), "hello big world");
  h.enqueue.mockResolvedValue([job({ id: "g1" })]);
  await user.click(screen.getByRole("button", { name: "Get timings" }));
  await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(1));
  finish("g1", { action: "lyrics", lines: LINES, matched, hasInstrumental: false });
  await screen.findByLabelText("Line 3 text");
}

const startOf = (n: number) => (screen.getByLabelText(`Line ${n} start`) as HTMLInputElement).value;

describe("LyricVideoView", () => {
  beforeEach(() => {
    h.enqueue.mockReset();
    h.open.mockReset();
    h.pickWith.mockReset();
    h.setState.mockReset();
    h.setState.mockResolvedValue(undefined);
    h.open.mockResolvedValue(SONG);
    h.playerMs.value = 0;
    h.played.value = false;
    useJobs.setState({ byId: {} });
    useUI.setState({ handoff: null, view: "lyric-video" });
    useDeps.getState().setAll([]);
    useModules.setState({
      byId: { "lyric-video": { id: "lyric-video", requires: ["ffmpeg", "ffprobe"], accepts: { extensions: [".mp3"] } } },
    } as unknown as Parameters<typeof useModules.setState>[0]);
  });

  it("starts with a drop zone and gated steps", () => {
    render(<LyricVideoView moduleId="lyric-video" />);
    expect(screen.getByText("Drop a song")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Choose a song/ })).toBeTruthy();
    for (const name of [/Lyrics/, /Look/, /Render/]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("reads title and artist from the tags and shows the cover", async () => {
    render(<LyricVideoView moduleId="lyric-video" />);
    handOff(["/in/song.mp3"]);
    await waitFor(() => expect((screen.getByLabelText("Artist") as HTMLInputElement).value).toBe("Owl City"));
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Fireflies");
    await waitFor(() => expect(document.querySelector('[aria-label="Cover art"] img')).toBeTruthy());
    expect(screen.getByText(/has cover art/)).toBeTruthy();
  });

  it("shows an error when the song can't be opened", async () => {
    h.open.mockRejectedValue({ code: "validation", message: "Can't read this file" });
    render(<LyricVideoView moduleId="lyric-video" />);
    handOff(["/in/bad.mp3"]);
    expect((await screen.findAllByText("Can't read this file")).length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: /Next: Lyrics/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks for the lyrics before timing, then runs align with progress and Cancel", async () => {
    const user = userEvent.setup();
    await toLyrics(user);
    expect((screen.getByRole("button", { name: "Get timings" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Paste the words and Toolbox times them to the song.")).toBeTruthy();
    await user.type(screen.getByLabelText("Lyrics"), "hello big world");
    h.enqueue.mockResolvedValue([job({ id: "g1" })]);
    await user.click(screen.getByRole("button", { name: "Get timings" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(1));
    const [inputs, opts] = h.enqueue.mock.calls[0] as [string[], { action: string; source: string; text: string; look: { title: string; artist: string } }];
    expect(inputs).toEqual(["/in/song.mp3"]);
    expect(opts).toMatchObject({ action: "lyrics", source: "align", text: "hello big world", look: { title: "Fireflies", artist: "Owl City" } });

    act(() => useJobs.getState().upsert(job({ id: "g1", status: JobStatus.JobRunning, progress: 0.3, message: "Separating the vocals" }) as never));
    expect(await screen.findByText("Separating the vocals")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("detect and file sources send their own fields", async () => {
    const user = userEvent.setup();
    await toLyrics(user);
    h.enqueue.mockResolvedValue([job({ id: "g1" })]);
    h.pickWith.mockResolvedValue(["/in/song.lrc"]);
    await user.click(screen.getByRole("radio", { name: "From a file" }));
    await user.click(screen.getByRole("button", { name: /Choose a \.lrc/ }));
    await screen.findByText("song.lrc");
    expect(h.pickWith.mock.calls[0]?.[1]).toEqual([".lrc", ".srt", ".vtt", ".txt"]);
    await user.click(screen.getByRole("button", { name: "Get timings" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(1));
    expect(h.enqueue.mock.calls[0]?.[1]).toMatchObject({ source: "file", lyricsPath: "/in/song.lrc", text: "" });
  });

  it("blocks timing when the AI engine is missing", async () => {
    useModules.setState({
      byId: { "lyric-video": { id: "lyric-video", requires: ["ffmpeg", "ffprobe"], accepts: { extensions: [".mp3"] } } },
    } as unknown as Parameters<typeof useModules.setState>[0]);
    useDeps.getState().setAll([dep("ffmpeg", DepState.DepOK), dep("ffprobe", DepState.DepOK), dep("audio-engine", DepState.DepMissing)]);
    const user = userEvent.setup();
    await toLyrics(user);
    await user.type(screen.getByLabelText("Lyrics"), "words");
    expect(await screen.findByText("The AI engine isn't installed")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Get timings" }) as HTMLButtonElement).disabled).toBe(true);
    // A lyrics file that is not .txt needs no engine.
    h.pickWith.mockResolvedValue(["/in/song.lrc"]);
    await user.click(screen.getByRole("radio", { name: "From a file" }));
    await user.click(screen.getByRole("button", { name: /Choose a \.lrc/ }));
    await screen.findByText("song.lrc");
    await waitFor(() => expect((screen.getByRole("button", { name: "Get timings" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("shows a failed job and a submit-time error", async () => {
    const user = userEvent.setup();
    await toLyrics(user);
    await user.type(screen.getByLabelText("Lyrics"), "words");
    h.enqueue.mockRejectedValueOnce({ code: "validation", message: "Paste the lyrics first" });
    await user.click(screen.getByRole("button", { name: "Get timings" }));
    expect(await screen.findByText("Paste the lyrics first")).toBeTruthy();

    h.enqueue.mockResolvedValue([job({ id: "g2" })]);
    await user.click(screen.getByRole("button", { name: "Get timings" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(2));
    act(() => useJobs.getState().upsert(job({ id: "g2", status: JobStatus.JobFailed, error: "The engine crashed", errorHint: "Try again" }) as never));
    expect(await screen.findByText("The engine crashed")).toBeTruthy();
    expect(screen.getByText("Try again")).toBeTruthy();
  });

  it("fills the sheet from the result and warns when few words matched", async () => {
    const user = userEvent.setup();
    await withLines(user, 0.3);
    expect(screen.getAllByTestId("lyric-row")).toHaveLength(3);
    expect(startOf(1)).toBe("0:01.000");
    expect(startOf(2)).toBe("0:04.000");
    expect((screen.getByLabelText("Line 2 text") as HTMLInputElement).value).toBe("second line");
    expect(screen.getByText(/Couldn't follow the song well/)).toBeTruthy();
  });

  it("does not warn when the match is good, and says so when nothing was found", async () => {
    const user = userEvent.setup();
    await withLines(user, 0.95);
    expect(screen.queryByText(/Couldn't follow the song well/)).toBeNull();
  });

  it("shows the empty result state", async () => {
    const user = userEvent.setup();
    await toLyrics(user);
    await user.type(screen.getByLabelText("Lyrics"), "words");
    h.enqueue.mockResolvedValue([job({ id: "g1" })]);
    await user.click(screen.getByRole("button", { name: "Get timings" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalled());
    finish("g1", { action: "lyrics", lines: [], matched: 0, hasInstrumental: false });
    expect(await screen.findByText("No lyrics were found")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Continue to Look" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("nudges a line by 0.1 s (words included) and undoes it", async () => {
    const user = userEvent.setup();
    await withLines(user);
    await user.click(screen.getByRole("button", { name: "Line 2 0.1 s later" }));
    expect(startOf(2)).toBe("0:04.100");
    await user.click(screen.getByRole("button", { name: "Line 2 0.1 s earlier" }));
    await user.click(screen.getByRole("button", { name: "Line 2 0.1 s earlier" }));
    expect(startOf(2)).toBe("0:03.900");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(startOf(2)).toBe("0:04.000");
    await user.click(screen.getByRole("button", { name: "Redo" }));
    expect(startOf(2)).toBe("0:03.900");
  });

  it("edits a start time and flags a line that goes out of order", async () => {
    const user = userEvent.setup();
    await withLines(user);
    const start = screen.getByLabelText("Line 3 start");
    await user.clear(start);
    await user.type(start, "0:02{Enter}");
    expect(startOf(3)).toBe("0:02.000");
    expect(screen.getByText(/Line 3 starts before the line above it/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Continue to Look" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("inserts, deletes and shifts all lines", async () => {
    const user = userEvent.setup();
    await withLines(user);
    await user.click(screen.getByLabelText("Line 1 text"));
    await user.click(screen.getByRole("button", { name: "Insert line" }));
    expect(screen.getAllByTestId("lyric-row")).toHaveLength(4);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getAllByTestId("lyric-row")).toHaveLength(3);

    await user.type(screen.getByLabelText("Shift all by (ms)"), "500");
    await user.click(screen.getByRole("button", { name: "Shift all later" }));
    expect(startOf(1)).toBe("0:01.500");
    expect(startOf(3)).toBe("0:07.500");
    await user.click(screen.getByRole("button", { name: "Shift all earlier" }));
    expect(startOf(1)).toBe("0:01.000");
  });

  it("tap to sync: Space stamps lines, Backspace goes back, Esc ends", async () => {
    const user = userEvent.setup();
    await withLines(user);
    await user.click(screen.getByRole("button", { name: "Tap to sync" }));
    expect(h.played.value).toBe(true);
    expect(screen.getByText("hello big world", { selector: "strong" })).toBeTruthy();

    h.playerMs.value = 1500;
    await user.keyboard(" ");
    expect(startOf(1)).toBe("0:01.500");
    expect(screen.getByText("second line", { selector: "strong" })).toBeTruthy();

    h.playerMs.value = 4200;
    await user.keyboard(" ");
    expect(startOf(2)).toBe("0:04.200");
    expect(screen.getByText("third", { selector: "strong" })).toBeTruthy();

    // back one line and re-stamp it
    await user.keyboard("{Backspace}");
    expect(screen.getByText("second line", { selector: "strong" })).toBeTruthy();
    h.playerMs.value = 4300;
    await user.keyboard(" ");
    expect(startOf(2)).toBe("0:04.300");

    await user.keyboard("{Escape}");
    expect(screen.queryByText(/as each line starts/)).toBeNull();
    expect(h.played.value).toBe(false);
    expect(screen.getByRole("button", { name: "Tap to sync" })).toBeTruthy();
    // Space no longer stamps.
    h.playerMs.value = 9000;
    await user.keyboard(" ");
    expect(startOf(3)).toBe("0:07.000");
  });

  it("tap to sync ends by itself after the last line and keeps the order", async () => {
    const user = userEvent.setup();
    await withLines(user);
    await user.click(screen.getByRole("button", { name: "Tap to sync" }));
    h.playerMs.value = 5000;
    await user.keyboard(" ");
    await user.keyboard(" ");
    await user.keyboard(" ");
    expect(screen.queryByText(/as each line starts/)).toBeNull();
    expect([1, 2, 3].map(startOf)).toEqual(["0:05.000", "0:05.000", "0:05.000"]);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(startOf(3)).toBe("0:07.000");
  });

  it("exports the .lrc through the menu", async () => {
    const user = userEvent.setup();
    await withLines(user);
    h.enqueue.mockResolvedValue([job({ id: "l1" })]);
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("menuitem", { name: "Export .lrc" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(2));
    const opts = h.enqueue.mock.calls[1]?.[1] as { action: string; lines: Array<{ text: string; words: unknown[] }> };
    expect(opts.action).toBe("lrc");
    expect(opts.lines.map((l) => l.text)).toEqual(["hello big world", "second line", "third"]);
    expect(opts.lines[0]?.words).toHaveLength(3);
    finish("l1", { action: "lrc", lines: [], matched: 0, hasInstrumental: false, outputs: ["/o/Lyric videos/song.lrc"] });
    expect(await screen.findByText("song.lrc")).toBeTruthy();
  });

  it("windows a long sheet", async () => {
    const user = userEvent.setup();
    await toLyrics(user);
    await user.type(screen.getByLabelText("Lyrics"), "x");
    h.enqueue.mockResolvedValue([job({ id: "g1" })]);
    await user.click(screen.getByRole("button", { name: "Get timings" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalled());
    const many = Array.from({ length: 600 }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 800, text: `line ${i}`, words: [] }));
    finish("g1", { action: "lyrics", lines: many, matched: 1, hasInstrumental: false });
    await screen.findByLabelText("Line 1 text");
    expect(screen.getAllByTestId("lyric-row").length).toBeLessThan(60);
  });

  it("confirms before re-timing over edited lines", async () => {
    const user = userEvent.setup();
    await withLines(user);
    await user.click(screen.getByRole("button", { name: "Line 1 0.1 s later" }));
    await user.click(screen.getByRole("button", { name: "Get timings" }));
    expect(await screen.findByText("Discard your lyric edits?")).toBeTruthy();
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    h.enqueue.mockResolvedValue([job({ id: "g9" })]);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(2));
  });

  describe("look and render", () => {
    async function toLook(user: User) {
      await withLines(user);
      await user.click(screen.getByRole("button", { name: "Continue to Look" }));
      await screen.findByTestId("lyric-preview");
    }

    it("shows an approximate preview driven by the player and persists the look", async () => {
      const user = userEvent.setup();
      await toLook(user);
      expect(screen.getByText(/Preview is approximate/)).toBeTruthy();
      expect(screen.queryByTestId("preview-line")).toBeNull();
      act(() => h.emitTime.current?.(1750));
      const line = await screen.findByTestId("preview-line");
      expect(line.textContent).toBe("hello big world");
      // (5 + 1.5) / 13 characters sung
      expect(Number(line.getAttribute("data-progress"))).toBeCloseTo(50, 0);
      expect(screen.getByTestId("preview-next").textContent).toBe("second line");

      await user.click(screen.getByRole("switch", { name: "Show next line" }));
      expect(screen.queryByTestId("preview-next")).toBeNull();
      await user.click(screen.getByRole("radio", { name: "9:16" }));
      expect(screen.getByTestId("lyric-preview").getAttribute("data-aspect")).toBe("9:16");
      await user.click(screen.getByRole("radio", { name: "Wave" }));
      expect(screen.getByTestId("preview-visualizer")).toBeTruthy();

      await waitFor(() => expect(h.setState).toHaveBeenCalled());
      const [id, json] = h.setState.mock.calls.at(-1) as [string, string];
      expect(id).toBe("lyric-video");
      const saved = JSON.parse(json) as { aspect: string; look: { showNext: boolean; visualizer: string; title?: string } };
      expect(saved).toMatchObject({ aspect: "9:16", look: { showNext: false, visualizer: "wave" } });
      expect(saved.look.title).toBeUndefined();
    });

    it("picks a background image through the file picker", async () => {
      const user = userEvent.setup();
      await toLook(user);
      h.pickWith.mockResolvedValue(["/in/bg.png"]);
      await user.click(screen.getByRole("radio", { name: "Image" }));
      expect(screen.getByText("Choose a file to use this background.")).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Choose an image…" }));
      await screen.findByText("bg.png");
      expect(h.pickWith.mock.calls.at(-1)?.[1]).toContain(".png");
    });

    it("shows the title card before the first line", async () => {
      const user = userEvent.setup();
      await toLook(user);
      act(() => h.emitTime.current?.(500));
      expect((await screen.findByTestId("preview-title")).textContent).toContain("Fireflies");
    });

    it("blocks rendering until a chosen image/video background has a file", async () => {
      const user = userEvent.setup();
      await toLook(user);
      await user.click(screen.getByRole("radio", { name: "Video" }));
      await user.click(screen.getByRole("button", { name: "Continue to Render" }));
      expect(await screen.findByText(/Choose a background file/)).toBeTruthy();
      expect((screen.getByRole("button", { name: "Render video" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("renders a preview from the chosen start, then the full video with result cards", async () => {
      const user = userEvent.setup();
      await toLook(user);
      act(() => h.emitTime.current?.(2000));
      await user.click(screen.getByRole("button", { name: "Continue to Render" }));

      h.enqueue.mockResolvedValue([job({ id: "p1" })]);
      await user.click(screen.getByRole("button", { name: "Render 10 s preview" }));
      await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(2));
      const popts = h.enqueue.mock.calls[1]?.[1] as { action: string; previewStartMs: number; lines: unknown[]; aspect: string; height: number };
      expect(popts).toMatchObject({ action: "preview", previewStartMs: 2000, aspect: "16:9", height: 1080 });
      expect(popts.lines).toHaveLength(3);
      act(() => useJobs.getState().upsert(job({ id: "p1", status: JobStatus.JobRunning, progress: 0.5, message: "Encoding" }) as never));
      expect(await screen.findByText("Encoding")).toBeTruthy();
      finish("p1", { action: "preview", lines: [], matched: 0, hasInstrumental: false, previewPath: "/cache/preview-p1.mp4" });
      await waitFor(() => expect(h.open).toHaveBeenCalledWith("/cache/preview-p1.mp4"));
      expect(await screen.findByTestId("player")).toBeTruthy();

      h.enqueue.mockResolvedValue([job({ id: "r1" })]);
      await user.click(screen.getByRole("button", { name: "Render video" }));
      await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(3));
      expect(h.enqueue.mock.calls[2]?.[1]).toMatchObject({ action: "render" });
      finish(
        "r1",
        { action: "render", lines: [], matched: 0, hasInstrumental: false, outputs: ["/o/Lyric videos/song (lyric video).mp4", "/o/Lyric videos/song.lrc"] },
        {
          outputs: [
            { id: "o1", path: "/o/Lyric videos/song (lyric video).mp4" },
            { id: "o2", path: "/o/Lyric videos/song.lrc" },
          ] as never,
        },
      );
      const card = await screen.findByLabelText("Result");
      expect(within(card).getByText("song (lyric video).mp4")).toBeTruthy();
      expect(within(card).getByText("song.lrc")).toBeTruthy();
    });

    it("shows a failed render", async () => {
      const user = userEvent.setup();
      await toLook(user);
      await user.click(screen.getByRole("button", { name: "Continue to Render" }));
      h.enqueue.mockResolvedValue([job({ id: "r1" })]);
      await user.click(screen.getByRole("button", { name: "Render video" }));
      await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(2));
      act(() => useJobs.getState().upsert(job({ id: "r1", status: JobStatus.JobFailed, error: "FFmpeg failed" }) as never));
      expect(await screen.findByText("FFmpeg failed")).toBeTruthy();
    });
  });
});
