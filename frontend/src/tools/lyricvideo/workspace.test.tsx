import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  loadRef: async () => ({ fixture: true }),
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

vi.mock("@/blocks/visuals/designer/VisualDesigner", () => ({
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

import { createStore } from "zustand/vanilla";
import { DepSource, DepState, JobStatus, PackComponentKind, PackComponentState, PackState, type DepStatus, type Job } from "@/lib/api";
import { setCurrentWindowForTest, parseWindow } from "@/lib/windows";
import { getPart } from "@/parts/registry";
import { compositionInputs } from "@/state/composition";
import { hostBridge, resetBridgeStatusesForTest, type BridgeTransport } from "@/state/bridge";
import { useDeps } from "@/state/deps";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { usePacks } from "@/state/packs";
import { useUI } from "@/state/ui";
import { setWorkspaceTransportForTest } from "@/workspace/defineWorkspace";
import { PRESETS, showFromPreset } from "@/viz/presets";
import { toRows } from "./logic";
import { DEFAULT_PREFS } from "./options";
import { resetLyricVideo, useLyricVideo } from "./store";
import LyricVideoView from "./LyricVideoView";
import { lyricVideoBridge, lyricVideoWorkspace } from "./workspace";

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
  act(() => useJobs.getState().upsert(job({ id, status: JobStatus.JobDone, progress: 1, resultJson: JSON.stringify(result), ...extra }) as never));
}

type User = ReturnType<typeof userEvent.setup>;

/** The workspace with a song: the header chip is "Song: Title — Artist". */
async function toWorkspace() {
  render(<LyricVideoView moduleId="lyric-video" />);
  handOff(["/in/song.mp3"]);
  await screen.findByRole("button", { name: "Song: Fireflies — Owl City" });
}

/** Opens a panel from the rail (or the header) and returns its drawer. */
async function openPanel(user: User, name: string, launcher?: string) {
  const open = screen.queryByRole("dialog", { name });
  if (open) return open;
  await user.click(screen.getByRole("button", { name: launcher ?? name }));
  const dialog = await screen.findByRole("dialog", { name });
  await waitFor(() => expect(within(dialog).queryByRole("status", { name: "Loading" })).toBeNull());
  return dialog;
}

const header = () => screen.getByRole("button", { name: /^Song: / }).closest("header") as HTMLElement;
const side = () => screen.getByRole("complementary");

/** Runs "Paste lyrics" in the Lyrics panel and finishes the job with LINES. */
async function withLines(user: User, matched = 0.9) {
  await toWorkspace();
  const dialog = await openPanel(user, "Lyrics");
  await user.type(within(dialog).getByLabelText("Lyrics"), "hello big world");
  h.enqueue.mockResolvedValue([job({ id: "g1" })]);
  await user.click(within(dialog).getByRole("button", { name: "Get timings" }));
  await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(1));
  finish("g1", { action: "lyrics", lines: LINES, matched, hasInstrumental: false });
  await within(side()).findByLabelText("Line 3 text");
  return dialog;
}

const startOf = (n: number) => (within(side()).getByLabelText(`Line ${n} start`) as HTMLInputElement).value;

beforeEach(() => {
  h.enqueue.mockReset();
  h.open.mockReset();
  h.pickWith.mockReset();
  h.setState.mockReset();
  h.setState.mockResolvedValue(undefined);
  h.open.mockResolvedValue(SONG);
  h.playerMs.value = 0;
  h.played.value = false;
  resetLyricVideo();
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

afterEach(() => {
  setWorkspaceTransportForTest(null);
  setCurrentWindowForTest(null);
  resetBridgeStatusesForTest();
});

describe("Lyric Video workspace", () => {
  it("is the drop zone until a song arrives, then one workspace (no stepper)", async () => {
    render(<LyricVideoView moduleId="lyric-video" />);
    expect(screen.getByText("Drop a song")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Choose a song/ })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Steps" })).toBeNull();
    handOff(["/in/song.mp3"]);
    expect(await screen.findByRole("button", { name: "Song: Fireflies — Owl City" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Steps" })).toBeNull();
    expect(useLyricVideo.getState().songPath).toBe("/in/song.mp3");
  });

  it("header: song chip, undo, redo, more, Render; rail: Song, Lyrics, Visuals, Look; stage and lines side", async () => {
    await toWorkspace();
    const hd = within(header());
    for (const name of ["Undo", "Redo", "More", "Render"]) expect(hd.getByRole("button", { name })).toBeTruthy();
    const rail = within(screen.getByRole("navigation", { name: "Panels" }));
    for (const name of ["Song", "Lyrics", "Visuals", "Look"]) expect(rail.getByRole("button", { name })).toBeTruthy();
    expect(await screen.findByTestId("lyric-preview")).toBeTruthy();
    expect(await within(side()).findByRole("list", { name: "Lyric lines" }).catch(() => null) ?? within(side()).getByText(/No lyrics yet/)).toBeTruthy();
  });

  it("reports the song for the Uses chips (Stems, Transcribe, Visualizer)", async () => {
    await toWorkspace();
    expect(compositionInputs("lyric-video", "stems")).toEqual(["/in/song.mp3"]);
    expect(compositionInputs("lyric-video", "transcribe")).toEqual(["/in/song.mp3"]);
    expect(compositionInputs("lyric-video", "visualizer")).toEqual(["/in/song.mp3"]);
  });

  describe("Song panel (was the Song step)", () => {
    it("reads title and artist from the tags, shows the cover, edits them and the audio choice", async () => {
      const user = userEvent.setup();
      await toWorkspace();
      const dialog = await openPanel(user, "Song", "Song: Fireflies — Owl City");
      expect((within(dialog).getByLabelText("Title") as HTMLInputElement).value).toBe("Fireflies");
      expect((within(dialog).getByLabelText("Artist") as HTMLInputElement).value).toBe("Owl City");
      await waitFor(() => expect(dialog.querySelector('[aria-label="Cover art"] img')).toBeTruthy());
      expect(await within(dialog).findByText(/has cover art/)).toBeTruthy();
      expect(within(dialog).getByRole("button", { name: "Change" })).toBeTruthy();
      await user.clear(within(dialog).getByLabelText("Title"));
      await user.type(within(dialog).getByLabelText("Title"), "Glowworms");
      expect(useLyricVideo.getState().meta.title).toBe("Glowworms");
      await user.click(within(dialog).getByRole("radio", { name: "Instrumental (karaoke)" }));
      expect(useLyricVideo.getState().prefs.audio).toBe("instrumental");
    });

    it("the Instrumental choice says so once the listening has the 4-stem mix", async () => {
      const user = userEvent.setup();
      h.analysis.current = analysisState({ ref: { key: "k", instrumental: "/cache/instrumental.flac", summary: { tempo: 90, key: "", hasStems: true } } });
      await toWorkspace();
      const dialog = await openPanel(user, "Song", "Song: Fireflies — Owl City");
      await user.click(within(dialog).getByRole("radio", { name: "Instrumental (karaoke)" }));
      expect(within(dialog).getByText(/already made for this song/)).toBeTruthy();
    });

    it("shows an error when the song can't be opened", async () => {
      const user = userEvent.setup();
      h.open.mockRejectedValue({ code: "validation", message: "Can't read this file" });
      render(<LyricVideoView moduleId="lyric-video" />);
      handOff(["/in/bad.mp3"]);
      await user.click(await screen.findByRole("button", { name: /^Song: / }));
      expect((await screen.findAllByText("Can't read this file")).length).toBeGreaterThan(0);
    });
  });

  describe("Lyrics panel (was the Lyrics step)", () => {
    it("asks for the lyrics before timing, then runs align with progress and Cancel", async () => {
      const user = userEvent.setup();
      await toWorkspace();
      const dialog = await openPanel(user, "Lyrics");
      expect((within(dialog).getByRole("button", { name: "Get timings" }) as HTMLButtonElement).disabled).toBe(true);
      expect(within(dialog).getByText("Paste the words and Toolbox times them to the song.")).toBeTruthy();
      await user.type(within(dialog).getByLabelText("Lyrics"), "hello big world");
      h.enqueue.mockResolvedValue([job({ id: "g1" })]);
      await user.click(within(dialog).getByRole("button", { name: "Get timings" }));
      await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(1));
      const [inputs, opts] = h.enqueue.mock.calls[0] as [string[], { action: string; source: string; text: string; look: { title: string; artist: string } }];
      expect(inputs).toEqual(["/in/song.mp3"]);
      expect(opts).toMatchObject({ action: "lyrics", source: "align", text: "hello big world", look: { title: "Fireflies", artist: "Owl City" } });

      act(() => useJobs.getState().upsert(job({ id: "g1", status: JobStatus.JobRunning, progress: 0.3, message: "Separating the vocals" }) as never));
      expect((await screen.findAllByText(/Separating the vocals/)).length).toBeGreaterThan(0);
      // The side shows the progress while the lyrics are being detected.
      expect(within(side()).getByTestId("timing-progress")).toBeTruthy();
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
    });

    it("detect and file sources send their own fields", async () => {
      const user = userEvent.setup();
      await toWorkspace();
      const dialog = await openPanel(user, "Lyrics");
      h.enqueue.mockResolvedValue([job({ id: "g1" })]);
      h.pickWith.mockResolvedValue(["/in/song.lrc"]);
      await user.click(within(dialog).getByRole("radio", { name: "From a file" }));
      await user.click(within(dialog).getByRole("button", { name: /Choose a \.lrc/ }));
      await within(dialog).findByText("song.lrc");
      expect(h.pickWith.mock.calls[0]?.[1]).toEqual([".lrc", ".srt", ".vtt", ".txt"]);
      await user.click(within(dialog).getByRole("button", { name: "Get timings" }));
      await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(1));
      expect(h.enqueue.mock.calls[0]?.[1]).toMatchObject({ source: "file", lyricsPath: "/in/song.lrc", text: "" });
      await user.click(within(dialog).getByRole("radio", { name: "Detect from the song" }));
      expect(within(dialog).getByLabelText("Sung language")).toBeTruthy();
    });

    it("blocks timing when the AI engine is missing", async () => {
      const user = userEvent.setup();
      useDeps.getState().setAll([dep("ffmpeg", DepState.DepOK), dep("ffprobe", DepState.DepOK), dep("audio-engine", DepState.DepMissing)]);
      await toWorkspace();
      const dialog = await openPanel(user, "Lyrics");
      await user.type(within(dialog).getByLabelText("Lyrics"), "words");
      expect(await within(dialog).findByText("The AI engine isn't installed")).toBeTruthy();
      expect((within(dialog).getByRole("button", { name: "Get timings" }) as HTMLButtonElement).disabled).toBe(true);
      // A lyrics file that is not .txt needs no engine.
      h.pickWith.mockResolvedValue(["/in/song.lrc"]);
      await user.click(within(dialog).getByRole("radio", { name: "From a file" }));
      await user.click(within(dialog).getByRole("button", { name: /Choose a \.lrc/ }));
      await within(dialog).findByText("song.lrc");
      await waitFor(() => expect((within(dialog).getByRole("button", { name: "Get timings" }) as HTMLButtonElement).disabled).toBe(false));
    });

    it("shows a failed job and a submit-time error", async () => {
      const user = userEvent.setup();
      await toWorkspace();
      const dialog = await openPanel(user, "Lyrics");
      await user.type(within(dialog).getByLabelText("Lyrics"), "words");
      h.enqueue.mockRejectedValueOnce({ code: "validation", message: "Paste the lyrics first" });
      await user.click(within(dialog).getByRole("button", { name: "Get timings" }));
      expect(await within(dialog).findByText("Paste the lyrics first")).toBeTruthy();
      h.enqueue.mockResolvedValue([job({ id: "g2" })]);
      await user.click(within(dialog).getByRole("button", { name: "Get timings" }));
      await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(2));
      act(() => useJobs.getState().upsert(job({ id: "g2", status: JobStatus.JobFailed, error: "The engine crashed", errorHint: "Try again" }) as never));
      expect(await within(dialog).findByText("The engine crashed")).toBeTruthy();
    });

    it("warns when few words matched, and says so when nothing was found", async () => {
      const user = userEvent.setup();
      const dialog = await withLines(user, 0.3);
      expect(within(side()).getAllByTestId("lyric-row")).toHaveLength(3);
      expect(startOf(1)).toBe("0:01.000");
      expect(startOf(2)).toBe("0:04.000");
      expect((within(side()).getByLabelText("Line 2 text") as HTMLInputElement).value).toBe("second line");
      expect(screen.getByText(/Couldn't follow the song well/)).toBeTruthy();
      expect(useLyricVideo.getState().matched).toBe(0.3);

      await user.type(within(dialog).getByLabelText("Lyrics"), "x");
      h.enqueue.mockResolvedValue([job({ id: "g5" })]);
      await user.click(within(dialog).getByRole("button", { name: "Get timings" }));
      // Re-timing over untouched lines needs no confirmation.
      await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(2));
      finish("g5", { action: "lyrics", lines: [], matched: 0, hasInstrumental: false });
      expect(await screen.findByText("No lyrics were found")).toBeTruthy();
    });

    it("confirms before re-timing over edited lines", async () => {
      const user = userEvent.setup();
      await withLines(user);
      await user.click(within(side()).getByRole("button", { name: "Line 1 0.1 s later" }));
      const dialog = await openPanel(user, "Lyrics");
      await user.click(within(dialog).getByRole("button", { name: "Get timings" }));
      expect(await screen.findByText("Discard your lyric edits?")).toBeTruthy();
      expect(h.enqueue).toHaveBeenCalledTimes(1);
      h.enqueue.mockResolvedValue([job({ id: "g9" })]);
      await user.click(screen.getByRole("button", { name: "Discard" }));
      await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(2));
    });
  });

  describe("lyric lines (the side; was the sheet of the Lyrics step)", () => {
    it("nudges a line by 0.1 s (words included) and undoes it from the header", async () => {
      const user = userEvent.setup();
      await withLines(user);
      await user.click(within(side()).getByRole("button", { name: "Line 2 0.1 s later" }));
      expect(startOf(2)).toBe("0:04.100");
      await user.click(within(side()).getByRole("button", { name: "Line 2 0.1 s earlier" }));
      await user.click(within(side()).getByRole("button", { name: "Line 2 0.1 s earlier" }));
      expect(startOf(2)).toBe("0:03.900");
      await user.click(within(header()).getByRole("button", { name: "Undo" }));
      expect(startOf(2)).toBe("0:04.000");
      await user.click(within(header()).getByRole("button", { name: "Redo" }));
      expect(startOf(2)).toBe("0:03.900");
      await user.click(within(side()).getByRole("button", { name: "Undo" }));
      expect(startOf(2)).toBe("0:04.000");
    });

    it("edits a start time and flags a line that goes out of order", async () => {
      const user = userEvent.setup();
      await withLines(user);
      const start = within(side()).getByLabelText("Line 3 start");
      await user.clear(start);
      await user.type(start, "0:02{Enter}");
      expect(startOf(3)).toBe("0:02.000");
      expect(screen.getByText(/Line 3 starts before the line above it/)).toBeTruthy();
    });

    it("inserts, deletes and shifts all lines", async () => {
      const user = userEvent.setup();
      await withLines(user);
      await user.click(within(side()).getByLabelText("Line 1 text"));
      await user.click(within(side()).getByRole("button", { name: "Insert line" }));
      expect(within(side()).getAllByTestId("lyric-row")).toHaveLength(4);
      await user.click(within(side()).getByRole("button", { name: "Delete line" }));
      expect(within(side()).getAllByTestId("lyric-row")).toHaveLength(3);

      await user.click(within(side()).getByRole("button", { name: "Shift timing" }));
      const dialog = await screen.findByRole("dialog", { name: "Shift timing" });
      await user.type(within(dialog).getByLabelText("Shift all by (ms)"), "500");
      await user.click(within(dialog).getByRole("button", { name: "Shift all later" }));
      expect(startOf(1)).toBe("0:01.500");
      expect(startOf(3)).toBe("0:07.500");
      await user.click(within(dialog).getByRole("button", { name: "Shift all earlier" }));
      expect(startOf(1)).toBe("0:01.000");
    });

    it("tap to sync: Space stamps lines, Backspace goes back, Esc ends", async () => {
      const user = userEvent.setup();
      await withLines(user);
      await user.click(within(side()).getByRole("button", { name: "Tap to sync" }));
      expect(h.played.value).toBe(true);
      expect(within(side()).getByText("hello big world", { selector: "strong" })).toBeTruthy();

      h.playerMs.value = 1500;
      await user.keyboard(" ");
      expect(startOf(1)).toBe("0:01.500");
      expect(within(side()).getByText("second line", { selector: "strong" })).toBeTruthy();

      h.playerMs.value = 4200;
      await user.keyboard(" ");
      expect(startOf(2)).toBe("0:04.200");
      await user.keyboard("{Backspace}");
      expect(within(side()).getByText("second line", { selector: "strong" })).toBeTruthy();
      h.playerMs.value = 4300;
      await user.keyboard(" ");
      expect(startOf(2)).toBe("0:04.300");

      await user.keyboard("{Escape}");
      expect(screen.queryByText(/as each line starts/)).toBeNull();
      expect(h.played.value).toBe(false);
      h.playerMs.value = 9000;
      await user.keyboard(" ");
      expect(startOf(3)).toBe("0:07.000");
    });

    it("exports the .lrc through the menu", async () => {
      const user = userEvent.setup();
      await withLines(user);
      h.enqueue.mockResolvedValue([job({ id: "l1" })]);
      await user.click(within(side()).getByRole("button", { name: "More" }));
      await user.click(await screen.findByRole("menuitem", { name: "Export .lrc" }));
      await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(2));
      const opts = h.enqueue.mock.calls[1]?.[1] as { action: string; lines: Array<{ text: string; words: unknown[] }> };
      expect(opts.action).toBe("lrc");
      expect(opts.lines.map((l) => l.text)).toEqual(["hello big world", "second line", "third"]);
      expect(opts.lines[0]?.words).toHaveLength(3);
      finish("l1", { action: "lrc", lines: [], matched: 0, hasInstrumental: false, outputs: ["/o/Lyric videos/song.lrc"] });
      expect(await within(side()).findByText("song.lrc")).toBeTruthy();
    });

    it("windows a long sheet", async () => {
      const user = userEvent.setup();
      await toWorkspace();
      const many = Array.from({ length: 600 }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 800, text: `line ${i}`, words: [] }));
      act(() => useLyricVideo.getState().resetSheet(toRows(many)));
      await within(side()).findByLabelText("Line 1 text");
      expect(within(side()).getAllByTestId("lyric-row").length).toBeLessThan(60);
      expect(user).toBeTruthy();
    });

    it("a new song asks before discarding edited lines", async () => {
      const user = userEvent.setup();
      await withLines(user);
      await user.click(within(side()).getByRole("button", { name: "Line 1 0.1 s later" }));
      handOff(["/in/other.mp3"]);
      expect(await screen.findByText("Discard your lyric edits?")).toBeTruthy();
      expect(useLyricVideo.getState().songPath).toBe("/in/song.mp3");
      await user.click(screen.getByRole("button", { name: "Discard" }));
      await waitFor(() => expect(useLyricVideo.getState().songPath).toBe("/in/other.mp3"));
      expect(useLyricVideo.getState().rows).toHaveLength(0);
    });
  });

  describe("Visuals panel (was the Visuals step)", () => {
    async function toVisuals(user: User) {
      await withLines(user);
      const dialog = await openPanel(user, "Visuals");
      await within(dialog).findByRole("radiogroup", { name: "Visuals" });
      return dialog;
    }
    const lastCall = () => h.analysisCalls.at(-1);
    const lastSaved = () =>
      JSON.parse((h.setState.mock.calls.at(-1) as [string, string])[1]) as {
        visualsMode: string;
        look: { background: string; visuals: { showJson: string; stems: boolean } };
      };

    it("starts the analysis by itself on opening the panel, with the sheet as the words", async () => {
      const user = userEvent.setup();
      await withLines(user);
      expect(h.analysisCalls.every((c) => c.path === null || !c.opts.auto)).toBe(true);
      await openPanel(user, "Visuals");
      await waitFor(() => expect(lastCall()?.opts.auto).toBe(true));
      const c = lastCall();
      expect(c?.path).toBe("/in/song.mp3");
      expect(c?.opts.analyze).toMatchObject({ words: "given", mood: true, stems: true, saveStems: false });
      expect((c?.opts.analyze.lines as Array<{ text: string }>).map((l) => l.text)).toEqual(["hello big world", "second line", "third"]);
    });

    it("shows the listening progress", async () => {
      const user = userEvent.setup();
      h.analysis.current = analysisState({ status: "running", progress: 0.4, stage: "Separating the instruments", analysis: null });
      const dialog = await toVisuals(user);
      expect(within(dialog).getByText(/Listening to the song… 40%/)).toBeTruthy();
      expect(within(dialog).getByText("Separating the instruments")).toBeTruthy();
      expect(screen.queryByTestId("picker")).toBeNull();
    });

    it("offers the instrument model when it isn't downloaded and analyses without stems", async () => {
      const user = userEvent.setup();
      setPacks(PackComponentState.ComponentMissing);
      const dialog = await toVisuals(user);
      expect(within(dialog).getByText("The instrument separation model isn't downloaded")).toBeTruthy();
      expect(within(dialog).getByRole("button", { name: /^Instruments/ }).textContent).toContain("Model not downloaded");
      await waitFor(() => expect(lastCall()?.opts.analyze.stems).toBe(false));
    });

    it("switches Quick, Full designer (on the stage) and Classic, and remembers the choice", async () => {
      const user = userEvent.setup();
      let dialog = await toVisuals(user);
      expect(within(dialog).getByTestId("picker").getAttribute("data-mode")).toBe("background");
      expect(within(dialog).getByTestId("picker").getAttribute("data-lines")).toBe("3");
      expect(within(dialog).getByTestId("design-label").textContent).toBe("Design: Classic");
      act(() => h.pickDesign.current?.({ showJson: PRESET_JSON, stems: true, useWords: true }));
      expect(within(dialog).getByTestId("design-label").textContent).toContain(PRESET.name);
      await waitFor(() => expect(lastSaved()).toMatchObject({ visualsMode: "quick", look: { background: "visualizer" } }));

      await user.click(within(dialog).getByRole("radio", { name: "Full designer" }));
      const designer = await screen.findByTestId("designer");
      expect(designer.getAttribute("data-aspect")).toBe(String(16 / 9));
      expect(designer.getAttribute("data-player")).toBe("null");
      expect(designer.getAttribute("data-tabs")).toBe("presets,look,reactions,layers,timeline");
      expect(within(screen.getByTestId("designer-text")).getByTestId("preview-line").textContent).toBe("hello big world");
      await user.click(screen.getByRole("button", { name: "Edit design" }));
      // (clicking the stage closed the drawer)
      await waitFor(() => expect(useLyricVideo.getState().prefs.look.visuals.showJson).toContain("Edited"));
      dialog = await openPanel(user, "Visuals");
      expect(within(dialog).getByTestId("design-label").textContent).toContain("Custom design");
      await waitFor(() => expect(lastSaved()).toMatchObject({ visualsMode: "designer", look: { background: "visualizer" } }));
      expect(JSON.parse(lastSaved().look.visuals.showJson)).toMatchObject({ name: "Edited", reactivity: 1.5 });
      // The header's Undo takes the design back while the designer is open.
      await user.click(within(header()).getByRole("button", { name: "Undo" }));
      await waitFor(() => expect(screen.getByTestId("designer-name").textContent).toBe(PRESET.name));

      dialog = await openPanel(user, "Visuals");
      await user.click(within(dialog).getByRole("radio", { name: "Classic background" }));
      expect(within(dialog).getByTestId("design-label").textContent).toBe("Design: Classic");
      expect(screen.queryByTestId("designer")).toBeNull();
      await waitFor(() => expect(lastSaved()).toMatchObject({ visualsMode: "classic", look: { background: "blur-cover" } }));
      expect(lastSaved().look.visuals.showJson).not.toBe("");
      await user.click(within(dialog).getByRole("radio", { name: "Quick" }));
      expect(within(dialog).getByTestId("design-label").textContent).toContain(PRESET.name);
    });

    it("the full designer starts from a design of its own when none is chosen", async () => {
      const user = userEvent.setup();
      const dialog = await toVisuals(user);
      await user.click(within(dialog).getByRole("radio", { name: "Full designer" }));
      await screen.findByTestId("designer");
      await waitFor(() => expect(lastSaved()).toMatchObject({ visualsMode: "designer", look: { background: "visualizer" } }));
      expect(lastSaved().look.visuals.showJson).not.toBe("");
    });

    it("sends saveStems with the analysis and runs the separation again when ticked late", async () => {
      const user = userEvent.setup();
      const dialog = await toVisuals(user);
      expect(within(dialog).getByRole("button", { name: /^Instruments/ }).textContent).toContain("Separated");
      await user.click(within(dialog).getByRole("button", { name: /^Instruments/ }));
      const box = (await screen.findByRole("checkbox", { name: "Also save the stems to the Library" })) as HTMLInputElement;
      expect(box.checked).toBe(false);
      await user.click(box);
      await waitFor(() => expect(lastCall()?.opts.analyze).toMatchObject({ stems: true, saveStems: true }));
      await waitFor(() => expect((h.analysis.current.start as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1));
    });

    it("hands the sheet and its look to the Visualizer", async () => {
      const user = userEvent.setup();
      const dialog = await toVisuals(user);
      await user.click(within(dialog).getByRole("button", { name: "Make the whole video in Visualizer" }));
      const handoff = useUI.getState().handoff;
      expect(handoff).toMatchObject({
        moduleId: "visualizer",
        inputs: ["/in/song.mp3"],
        seed: { kind: "timed-text", from: "lyric-video", look: { font: "Arial", textColor: "#ffffff", highlightColor: "#ffd166", karaoke: true, position: "center" } },
      });
      expect(handoff?.seed?.lines.map((l) => l.text)).toEqual(["hello big world", "second line", "third"]);
    });

    it("the header's More menu also opens the Visualizer with the seed", async () => {
      const user = userEvent.setup();
      await withLines(user);
      await user.click(within(header()).getByRole("button", { name: "More" }));
      await user.click(await screen.findByRole("menuitem", { name: "Make the whole video in Visualizer" }));
      expect(useUI.getState().handoff).toMatchObject({ moduleId: "visualizer", seed: { kind: "timed-text" } });
    });
  });

  describe("Look panel and the preview (was the Look step)", () => {
    it("the stage preview follows the player; the Look panel's controls change it and persist", async () => {
      const user = userEvent.setup();
      await withLines(user);
      expect(screen.queryByTestId("preview-line")).toBeNull();
      act(() => h.emitTime.current?.(1750));
      const line = await screen.findByTestId("preview-line");
      expect(line.textContent).toBe("hello big world");
      expect(Number(line.getAttribute("data-progress"))).toBeCloseTo(50, 0);
      expect(screen.getByTestId("preview-next").textContent).toBe("second line");

      const dialog = await openPanel(user, "Look");
      await user.click(within(dialog).getByRole("switch", { name: "Show next line" }));
      expect(screen.queryByTestId("preview-next")).toBeNull();
      await user.click(within(dialog).getByRole("radio", { name: "9:16" }));
      expect(screen.getByTestId("lyric-preview").getAttribute("data-aspect")).toBe("9:16");
      await user.click(within(dialog).getByRole("radio", { name: "720p" }));
      await user.click(within(dialog).getByRole("radio", { name: "Wave" }));
      expect(screen.getByTestId("preview-visualizer")).toBeTruthy();
      await user.click(within(dialog).getByRole("radio", { name: "Lower" }));
      await user.click(within(dialog).getByRole("switch", { name: "Karaoke fill" }));
      expect(within(dialog).getByLabelText("Font")).toBeTruthy();
      expect(within(dialog).getByLabelText("Text colour")).toBeTruthy();
      expect(within(dialog).getByLabelText("Highlight colour")).toBeTruthy();

      await waitFor(() => expect(h.setState).toHaveBeenCalled());
      const [id, json] = h.setState.mock.calls.at(-1) as [string, string];
      expect(id).toBe("lyric-video");
      const saved = JSON.parse(json) as { aspect: string; height: number; look: { showNext: boolean; visualizer: string; position: string; karaoke: boolean; title?: string } };
      expect(saved).toMatchObject({ aspect: "9:16", height: 720, look: { showNext: false, visualizer: "wave", position: "lower", karaoke: false } });
      expect(saved.look.title).toBeUndefined();
    });

    it("picks a background image through the file picker", async () => {
      const user = userEvent.setup();
      await toWorkspace();
      const dialog = await openPanel(user, "Look");
      h.pickWith.mockResolvedValue(["/in/bg.png"]);
      await user.click(within(dialog).getByRole("radio", { name: "Image" }));
      expect(within(dialog).getByText("Choose a file to use this background.")).toBeTruthy();
      await user.click(within(dialog).getByRole("button", { name: "Choose an image…" }));
      await within(dialog).findByText("bg.png");
      expect(h.pickWith.mock.calls.at(-1)?.[1]).toContain(".png");
      expect(useLyricVideo.getState().prefs.look.backgroundPath).toBe("/in/bg.png");
    });

    it("shows the title card before the first line", async () => {
      const user = userEvent.setup();
      await withLines(user);
      act(() => h.emitTime.current?.(500));
      expect((await screen.findByTestId("preview-title")).textContent).toContain("Fireflies");
    });

    it("with a visuals background: Visuals: <design>, a Change link, the live canvas, no strip options", async () => {
      const user = userEvent.setup();
      await withLines(user);
      act(() => useLyricVideo.getState().setPrefs((o) => ({ ...o, look: { ...o.look, background: "visualizer", visuals: { showJson: PRESET_JSON, stems: true, useWords: true } } })));
      const dialog = await openPanel(user, "Look");
      expect(within(dialog).getByTestId("visuals-label").textContent).toBe(`Visuals: ${PRESET.name}`);
      expect(await screen.findByTestId("visuals-canvas")).toBeTruthy();
      expect(within(dialog).queryByRole("radio", { name: "Blurred cover" })).toBeNull();
      expect(within(dialog).queryByRole("radiogroup", { name: "Visualiser" })).toBeNull();
      await user.click(within(dialog).getByRole("button", { name: "Change" }));
      expect(await screen.findByRole("dialog", { name: "Visuals" })).toBeTruthy();
    });
  });

  describe("Render panel (was the Render step)", () => {
    it("renders a preview from the chosen start, then the full video with result cards", async () => {
      const user = userEvent.setup();
      await withLines(user);
      act(() => useLyricVideo.getState().setPreviewStartMs(2000));
      const dialog = await openPanel(user, "Render", "Render");
      h.enqueue.mockResolvedValue([job({ id: "p1" })]);
      await user.click(within(dialog).getByRole("button", { name: "Render 10 s preview" }));
      await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(2));
      const popts = h.enqueue.mock.calls[1]?.[1] as { action: string; previewStartMs: number; lines: unknown[]; aspect: string; height: number };
      expect(popts).toMatchObject({ action: "preview", previewStartMs: 2000, aspect: "16:9", height: 1080 });
      expect(popts.lines).toHaveLength(3);
      act(() => useJobs.getState().upsert(job({ id: "p1", status: JobStatus.JobRunning, progress: 0.5, message: "Encoding" }) as never));
      expect(await within(dialog).findByText("Encoding")).toBeTruthy();
      finish("p1", { action: "preview", lines: [], matched: 0, hasInstrumental: false, previewPath: "/cache/preview-p1.mp4" });
      await waitFor(() => expect(h.open).toHaveBeenCalledWith("/cache/preview-p1.mp4"));

      h.enqueue.mockResolvedValue([job({ id: "r1" })]);
      await user.click(within(dialog).getByRole("button", { name: "Render video" }));
      await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(3));
      expect(h.enqueue.mock.calls[2]?.[1]).toMatchObject({ action: "render" });
      finish(
        "r1",
        { action: "render", lines: [], matched: 0, hasInstrumental: false, outputs: ["/o/Lyric videos/song (lyric video).mp4", "/o/Lyric videos/song.lrc"] },
        { outputs: [{ id: "o1", path: "/o/Lyric videos/song (lyric video).mp4" }, { id: "o2", path: "/o/Lyric videos/song.lrc" }] as never },
      );
      const card = await within(dialog).findByLabelText("Result");
      expect(within(card).getByText("song (lyric video).mp4")).toBeTruthy();
      expect(within(card).getByText("song.lrc")).toBeTruthy();
    });

    it("keeps its job when the panel is closed and opened again", async () => {
      const user = userEvent.setup();
      await withLines(user);
      let dialog = await openPanel(user, "Render");
      h.enqueue.mockResolvedValue([job({ id: "r1" })]);
      await user.click(within(dialog).getByRole("button", { name: "Render video" }));
      await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(2));
      act(() => useJobs.getState().upsert(job({ id: "r1", status: JobStatus.JobRunning, progress: 0.2, message: "Rendering frames" }) as never));
      await user.click(within(dialog).getByRole("button", { name: "Close" }));
      dialog = await openPanel(user, "Render");
      expect(await within(dialog).findByText("Rendering frames")).toBeTruthy();
    });

    it("blocks rendering until a chosen image/video background has a file", async () => {
      const user = userEvent.setup();
      await withLines(user);
      act(() => useLyricVideo.getState().setPrefs((o) => ({ ...o, look: { ...o.look, background: "video" } })));
      const dialog = await openPanel(user, "Render");
      expect(await within(dialog).findByText(/Choose a background file/)).toBeTruthy();
      expect((within(dialog).getByRole("button", { name: "Render video" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("shows a failed render", async () => {
      const user = userEvent.setup();
      await withLines(user);
      const dialog = await openPanel(user, "Render");
      h.enqueue.mockResolvedValue([job({ id: "r1" })]);
      await user.click(within(dialog).getByRole("button", { name: "Render video" }));
      await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(2));
      act(() => useJobs.getState().upsert(job({ id: "r1", status: JobStatus.JobFailed, error: "FFmpeg failed" }) as never));
      expect(await within(dialog).findByText("FFmpeg failed")).toBeTruthy();
    });

    it("needs the AI engine for instrumental audio only", async () => {
      const user = userEvent.setup();
      useDeps.getState().setAll([dep("ffmpeg", DepState.DepOK), dep("ffprobe", DepState.DepOK), dep("audio-engine", DepState.DepMissing)]);
      await toWorkspace();
      act(() => useLyricVideo.getState().resetSheet(toRows(LINES)));
      let dialog = await openPanel(user, "Render");
      expect(within(dialog).queryByText("The AI engine isn't installed")).toBeNull();
      expect((within(dialog).getByRole("button", { name: "Render video" }) as HTMLButtonElement).disabled).toBe(false);
      act(() => useLyricVideo.getState().setPrefs((o) => ({ ...o, audio: "instrumental" })));
      dialog = await screen.findByRole("dialog", { name: "Render" });
      expect(await within(dialog).findByText("The AI engine isn't installed")).toBeTruthy();
      expect((within(dialog).getByRole("button", { name: "Render video" }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("keeps the song and the sheet when the tool is closed and opened again", async () => {
    const user = userEvent.setup();
    await withLines(user);
    cleanup();
    render(<LyricVideoView moduleId="lyric-video" />);
    expect(await screen.findByRole("button", { name: "Song: Fireflies — Owl City" })).toBeTruthy();
    expect(((await within(side()).findByLabelText("Line 3 text")) as HTMLInputElement).value).toBe("third");
  });
});

describe("Lyric Video preview and lines over the workspace bridge", () => {
  function setup() {
    const hub = new Map<string, Set<(p: unknown, from: string) => void>>();
    const endpoint = (key: string): BridgeTransport => ({
      send: (payload, to = "") => {
        const wire = JSON.parse(JSON.stringify(payload)) as unknown;
        for (const [k, set] of hub) {
          if (k === key || (to && to !== k)) continue;
          for (const cb of [...set]) cb(wire, key);
        }
      },
      on: (cb) => {
        const set = hub.get(key) ?? new Set();
        set.add(cb);
        hub.set(key, set);
        return () => set.delete(cb);
      },
    });
    setWorkspaceTransportForTest((side) => endpoint(side));
    const calls: Array<[string, unknown[]]> = [];
    const rec = (name: string) => (...args: unknown[]) => void calls.push([name, args]);
    const host = createStore<Record<string, unknown>>(() => ({
      songPath: "/in/song.mp3",
      meta: { title: "Fireflies", artist: "Owl City" },
      rows: toRows(LINES),
      canUndo: false,
      canRedo: false,
      matched: null,
      prefs: DEFAULT_PREFS,
      selectedId: "",
      playheadMs: 1750,
      playing: false,
      tapIndex: -1,
      durationMs: 120000,
      hasCover: false,
      coverUrl: undefined,
      imageUrl: undefined,
      listenRef: null,
      ...Object.fromEntries(lyricVideoBridge.actions.map((a) => [a, rec(a)])),
    }));
    const stop = hostBridge(host as never, { name: lyricVideoWorkspace.bridgeName, pick: lyricVideoBridge.pick as never, apply: lyricVideoBridge.apply as never, actions: [...lyricVideoBridge.actions] as never }, endpoint("host"));
    return { host, stop, calls };
  }

  it("the preview part renders from the host's store and forwards play/pause", async () => {
    const { stop, calls } = setup();
    setCurrentWindowForTest(parseWindow("?window=part&part=lyric-video.preview&key=part:lyric-video.preview"));
    const part = getPart("lyric-video.preview")!;
    const disconnect = await part.connect!(new URLSearchParams());
    const Part = part.component;
    render(<Part placement="window" />);
    expect((await screen.findByTestId("preview-line")).textContent).toBe("hello big world");
    expect(useLyricVideo.getState().songPath).toBe("/in/song.mp3");
    await userEvent.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() => expect(calls.some(([n]) => n === "togglePlay")).toBe(true));
    disconnect();
    stop();
  });

  it("the lines panel renders in a replica and an edit reaches the host", async () => {
    const { stop, calls } = setup();
    setCurrentWindowForTest(parseWindow("?window=part&part=lyric-video.panel&panel=lines&key=part:lyric-video.panel@lines"));
    const part = getPart("lyric-video.panel")!;
    const disconnect = await part.connect!(new URLSearchParams());
    const Part = part.component;
    render(<Part placement="window" />);
    const text = (await screen.findByLabelText("Line 2 text")) as HTMLInputElement;
    expect(text.value).toBe("second line");
    // A replica never exports the .lrc (that submits a job).
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Line 2 0.1 s later" }));
    await waitFor(() => expect(calls.some(([n]) => n === "nudge")).toBe(true));
    expect(calls.find(([n]) => n === "nudge")?.[1]).toEqual([useLyricVideo.getState().rows[1]?.id, 100]);
    disconnect();
    stop();
  });

  it("panels that pick files or submit jobs are not poppable; the lines panel is", () => {
    const poppable = lyricVideoWorkspace.panels.filter((p) => p.poppable !== false).map((p) => p.id);
    expect(poppable).toEqual(["lines"]);
    expect(lyricVideoWorkspace.previewPart).toBe("lyric-video.preview");
  });
});
