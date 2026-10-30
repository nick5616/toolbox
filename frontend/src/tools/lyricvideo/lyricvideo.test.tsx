import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
  analysis: { current: null as unknown as Record<string, unknown> },
  analysisCalls: [] as Array<{ path: string | null; opts: { auto: boolean; analyze: Record<string, unknown> } }>,
  pickDesign: { current: null as ((v: unknown) => void) | null },
}));

vi.mock("@/components/viz/useVisualsAnalysis", () => ({
  fixtureFlag: () => false,
  useVisualsAnalysis: (path: string | null, opts: { auto: boolean; analyze: Record<string, unknown> }) => {
    h.analysisCalls.push({ path, opts });
    return h.analysis.current;
  },
}));

vi.mock("@/components/viz", () => ({
  VisualsPicker: (p: { value: unknown; onChange: (v: unknown) => void; lines: unknown[] | null; mode: string }) => {
    h.pickDesign.current = p.onChange;
    return <div data-testid="picker" data-lines={p.lines?.length ?? 0} data-mode={p.mode} />;
  },
  VisualsCanvas: () => <div data-testid="visuals-canvas" />,
}));

vi.mock("@/tools/visualizer/designer/VisualDesigner", () => ({
  VisualDesigner: (p: {
    show: { name: string };
    onChange: (s: unknown) => void;
    aspect: number;
    player: unknown;
    text: { overlay: (rect: unknown, ms: number) => React.ReactNode };
    tabs?: string[];
  }) => (
    <div data-testid="designer" data-aspect={p.aspect} data-player={String(p.player)} data-tabs={(p.tabs ?? []).join(",")}>
      <span data-testid="designer-name">{p.show.name}</span>
      <button type="button" onClick={() => p.onChange({ ...p.show, name: "Edited", reactivity: 1.5 })}>
        Edit design
      </button>
      <div data-testid="designer-text">{p.text.overlay({ left: 0, top: 0, width: 100, height: 100 }, 1500)}</div>
    </div>
  ),
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
    VisualizerService: { MoodReaderReady: async () => true },
    PacksService: { InstallFor: async () => undefined },
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

import { DepSource, DepState, JobStatus, PackComponentKind, PackComponentState, PackState, type DepStatus, type Job } from "@/lib/api";
import { useDeps } from "@/state/deps";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { usePacks } from "@/state/packs";
import { useUI } from "@/state/ui";
import { PRESETS, showFromPreset } from "@/viz/presets";
import LyricVideoView from "./LyricVideoView";
import { resetSession } from "./session";

const PRESET = PRESETS[0]!;
const PRESET_JSON = JSON.stringify(showFromPreset(PRESET));

function analysisState(over: Record<string, unknown> = {}) {
  return {
    status: "ready",
    progress: 0,
    stage: "",
    ref: { key: "k", instrumental: "", summary: { tempo: 120, key: "A minor", hasStems: false } },
    analysis: { fixture: true },
    error: null,
    start: vi.fn(),
    cancel: vi.fn(),
    ...over,
  };
}

function setPacks(state: PackComponentState) {
  const comp = { id: "stems-default", name: "Demucs", state, kind: PackComponentKind.ComponentModel };
  const p = { id: "music", name: "Music", state: PackState.PackMissing, components: [comp], unlocks: [] };
  usePacks.setState({ list: [p], byId: { music: p }, loaded: true } as unknown as Parameters<typeof usePacks.setState>[0]);
}

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
    resetSession();
    h.analysis.current = analysisState();
    h.analysisCalls.length = 0;
    h.pickDesign.current = null;
    setPacks(PackComponentState.ComponentInstalled);
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
    expect((screen.getByRole("button", { name: "Continue to Visuals" }) as HTMLButtonElement).disabled).toBe(true);
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
    expect((screen.getByRole("button", { name: "Continue to Visuals" }) as HTMLButtonElement).disabled).toBe(true);
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

  describe("visuals", () => {
    async function toVisuals(user: User) {
      await withLines(user);
      await user.click(screen.getByRole("button", { name: "Continue to Visuals" }));
      await screen.findByRole("radiogroup", { name: "Visuals" });
    }
    const lastCall = () => h.analysisCalls.at(-1);
    const lastSaved = () => JSON.parse((h.setState.mock.calls.at(-1) as [string, string])[1]) as {
      visualsMode: string;
      look: { background: string; visuals: { showJson: string; stems: boolean } };
    };

    it("has the steps Song, Lyrics, Visuals, Look, Render", async () => {
      const user = userEvent.setup();
      await toVisuals(user);
      const names = within(screen.getByRole("navigation", { name: "Steps" }))
        .getAllByRole("button")
        .map((b) => b.textContent?.replace(/^\d+/, ""));
      expect(names).toEqual(["Song", "Lyrics", "Visuals", "Look", "Render"]);
      expect(screen.getByRole("button", { name: /Visuals/, current: "step" })).toBeTruthy();
    });

    it("starts the analysis by itself on entering the step, with the sheet as the words", async () => {
      const user = userEvent.setup();
      await withLines(user);
      // Before the step the song isn't being analysed.
      expect(h.analysisCalls.every((c) => c.path === null || !c.opts.auto)).toBe(true);
      await user.click(screen.getByRole("button", { name: "Continue to Visuals" }));
      await waitFor(() => expect(lastCall()?.opts.auto).toBe(true));
      const c = lastCall();
      expect(c?.path).toBe("/in/song.mp3");
      expect(c?.opts.analyze).toMatchObject({ words: "given", mood: true, stems: true, saveStems: false });
      const lines = c?.opts.analyze.lines as Array<{ text: string }>;
      expect(lines.map((l) => l.text)).toEqual(["hello big world", "second line", "third"]);
    });

    it("shows the listening progress and an error with Try again", async () => {
      const user = userEvent.setup();
      h.analysis.current = analysisState({ status: "running", progress: 0.4, stage: "Separating the instruments", analysis: null });
      await toVisuals(user);
      expect(screen.getByText(/Listening to the song… 40%/)).toBeTruthy();
      expect(screen.getByText("Separating the instruments")).toBeTruthy();
      expect(screen.queryByTestId("picker")).toBeNull();
    });

    it("offers the instrument model when it isn't downloaded and analyses without stems", async () => {
      const user = userEvent.setup();
      setPacks(PackComponentState.ComponentMissing);
      await toVisuals(user);
      expect(screen.getByText("The instrument separation model isn't downloaded")).toBeTruthy();
      expect(screen.getByRole("switch", { name: /Separate instruments/ }).getAttribute("aria-checked")).toBe("false");
      await waitFor(() => expect(lastCall()?.opts.analyze.stems).toBe(false));
    });

    it("switches Quick, Full designer and Classic, and remembers the choice", async () => {
      const user = userEvent.setup();
      await toVisuals(user);
      // Quick: the picker, in background mode, with the sheet as its lines.
      expect(screen.getByTestId("picker").getAttribute("data-mode")).toBe("background");
      expect(screen.getByTestId("picker").getAttribute("data-lines")).toBe("3");
      expect(screen.getByTestId("design-label").textContent).toBe("Design: Classic");
      act(() => h.pickDesign.current?.({ showJson: PRESET_JSON, stems: true, useWords: true }));
      expect(screen.getByTestId("design-label").textContent).toContain(PRESET.name);
      await waitFor(() => expect(lastSaved()).toMatchObject({ visualsMode: "quick", look: { background: "visualizer" } }));

      // Full designer: the embedded designer, aspect locked, the tool's own words over it.
      await user.click(screen.getByRole("radio", { name: "Full designer" }));
      const designer = await screen.findByTestId("designer");
      expect(designer.getAttribute("data-aspect")).toBe(String(16 / 9));
      expect(designer.getAttribute("data-player")).toBe("null");
      expect(designer.getAttribute("data-tabs")).toBe("presets,look,reactions,layers,timeline");
      expect(within(screen.getByTestId("designer-text")).getByTestId("preview-line").textContent).toBe("hello big world");
      await user.click(screen.getByRole("button", { name: "Edit design" }));
      await waitFor(() => expect(screen.getByTestId("design-label").textContent).toContain("Custom design"));
      await waitFor(() => expect(lastSaved()).toMatchObject({ visualsMode: "designer", look: { background: "visualizer" } }));
      expect(JSON.parse(lastSaved().look.visuals.showJson)).toMatchObject({ name: "Edited", reactivity: 1.5 });
      await user.click(screen.getByRole("button", { name: "Undo" }));
      await waitFor(() => expect(screen.getByTestId("designer-name").textContent).toBe(PRESET.name));

      // Classic: no visuals background.
      await user.click(screen.getByRole("radio", { name: "Classic background" }));
      expect(screen.getByTestId("design-label").textContent).toBe("Design: Classic");
      expect(screen.queryByTestId("designer")).toBeNull();
      await waitFor(() => expect(lastSaved()).toMatchObject({ visualsMode: "classic", look: { background: "blur-cover" } }));
      // The chosen design is kept for coming back.
      expect(lastSaved().look.visuals.showJson).not.toBe("");
      await user.click(screen.getByRole("radio", { name: "Quick" }));
      expect(screen.getByTestId("design-label").textContent).toContain(PRESET.name);
    });

    it("the full designer starts from a design of its own when none is chosen", async () => {
      const user = userEvent.setup();
      await toVisuals(user);
      await user.click(screen.getByRole("radio", { name: "Full designer" }));
      await screen.findByTestId("designer");
      await waitFor(() => expect(lastSaved()).toMatchObject({ visualsMode: "designer", look: { background: "visualizer" } }));
      expect(lastSaved().look.visuals.showJson).not.toBe("");
    });

    it("sends saveStems with the analysis and runs the separation again when ticked late", async () => {
      const user = userEvent.setup();
      await toVisuals(user);
      const box = screen.getByRole("checkbox", { name: "Also save the stems to the Library" }) as HTMLInputElement;
      expect(box.checked).toBe(false);
      expect(lastCall()?.opts.analyze.saveStems).toBe(false);
      await user.click(box);
      await waitFor(() => expect(lastCall()?.opts.analyze).toMatchObject({ stems: true, saveStems: true }));
      await waitFor(() => expect((h.analysis.current.start as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1));
    });

    it("hands the sheet and its look to the Visualizer", async () => {
      const user = userEvent.setup();
      await toVisuals(user);
      await user.click(screen.getByRole("button", { name: "Make the whole video in Visualizer" }));
      const handoff = useUI.getState().handoff;
      expect(handoff).toMatchObject({
        moduleId: "visualizer",
        inputs: ["/in/song.mp3"],
        seed: {
          kind: "timed-text",
          from: "lyric-video",
          look: { font: "Arial", textColor: "#ffffff", highlightColor: "#ffd166", karaoke: true, position: "center" },
        },
      });
      expect(handoff?.seed?.lines.map((l) => l.text)).toEqual(["hello big world", "second line", "third"]);
      expect(useUI.getState().view).toBe("visualizer");
    });

    it("the Song step's Instrumental uses the 4-stem mix once the analysis has one", async () => {
      const user = userEvent.setup();
      await toVisuals(user);
      h.analysis.current = analysisState({ ref: { key: "k", instrumental: "/cache/instrumental.flac", summary: { tempo: 90, key: "", hasStems: true } } });
      await user.click(screen.getByRole("radio", { name: "Classic background" })); // re-renders the view
      const steps = within(screen.getByRole("navigation", { name: "Steps" }));
      await user.click(steps.getByRole("button", { name: /Song/ }));
      await user.click(screen.getByRole("radio", { name: "Instrumental (karaoke)" }));
      expect(screen.getByText(/already made for this song/)).toBeTruthy();
    });

    it("keeps the song and the sheet when the tool is closed and opened again", async () => {
      const user = userEvent.setup();
      const first = render(<LyricVideoView moduleId="lyric-video" />);
      first.unmount();
      await withLines(user);
      cleanup();
      render(<LyricVideoView moduleId="lyric-video" />);
      expect(await screen.findByText("song.mp3")).toBeTruthy();
      expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Fireflies");
      await user.click(within(screen.getByRole("navigation", { name: "Steps" })).getByRole("button", { name: /Lyrics/ }));
      expect(((await screen.findByLabelText("Line 3 text")) as HTMLInputElement).value).toBe("third");
    });

    describe("on the Look step", () => {
      async function toVisualLook(user: User) {
        await toVisuals(user);
        act(() => h.pickDesign.current?.({ showJson: PRESET_JSON, stems: true, useWords: true }));
        await user.click(screen.getByRole("button", { name: "Continue to Look" }));
        await screen.findByTestId("lyric-preview");
      }

      it("shows Visuals: <design>, a Change link, the live canvas, and hides the strip option", async () => {
        const user = userEvent.setup();
        await toVisualLook(user);
        expect(screen.getByTestId("visuals-label").textContent).toBe(`Visuals: ${PRESET.name}`);
        expect(screen.getByTestId("visuals-canvas")).toBeTruthy();
        expect(screen.queryByRole("radio", { name: "Blurred cover" })).toBeNull();
        expect(screen.queryByRole("radiogroup", { name: "Visualiser" })).toBeNull();
        expect(screen.queryByTestId("preview-visualizer")).toBeNull();
        // The text options and the approximate note stay; the HTML lyrics are over the canvas.
        expect(screen.getByLabelText("Font")).toBeTruthy();
        expect(screen.getByText(/Preview is approximate/)).toBeTruthy();
        act(() => h.emitTime.current?.(1750));
        expect((await screen.findByTestId("preview-line")).textContent).toBe("hello big world");
        await user.click(screen.getByRole("button", { name: "Change" }));
        expect(await screen.findByRole("radiogroup", { name: "Visuals" })).toBeTruthy();
      });

      it("submits the visuals background with the render", async () => {
        const user = userEvent.setup();
        await toVisualLook(user);
        await user.click(screen.getByRole("button", { name: "Continue to Render" }));
        h.enqueue.mockResolvedValue([job({ id: "r1" })]);
        await user.click(screen.getByRole("button", { name: "Render video" }));
        await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(2));
        const o = h.enqueue.mock.calls[1]?.[1] as { action: string; look: { background: string; visuals: { showJson: string; stems: boolean; useWords: boolean } } };
        expect(o.action).toBe("render");
        expect(o.look.background).toBe("visualizer");
        expect(o.look.visuals).toMatchObject({ showJson: PRESET_JSON, stems: true, useWords: true });
      });

      it("blocks rendering when the visuals background has no design", async () => {
        const user = userEvent.setup();
        await toVisuals(user);
        await user.click(screen.getByRole("radio", { name: "Full designer" }));
        await screen.findByTestId("designer");
        await user.click(screen.getByRole("radio", { name: "Classic background" }));
        await user.click(screen.getByRole("button", { name: "Continue to Look" }));
        await screen.findByTestId("lyric-preview");
        expect(screen.queryByTestId("visuals-label")).toBeNull();
      });
    });
  });

  describe("look and render", () => {
    async function toLook(user: User) {
      await withLines(user);
      await user.click(screen.getByRole("button", { name: "Continue to Visuals" }));
      await user.click(await screen.findByRole("button", { name: "Continue to Look" }));
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
