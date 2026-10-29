import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enqueue: vi.fn(),
  setState: vi.fn(async (..._a: unknown[]) => undefined),
  keyframes: vi.fn(async (_p: string) => [0, 3000, 6000] as number[]),
  media: { current: { status: "ready" } as Record<string, unknown> },
  playerMs: { value: 0 },
  seeks: [] as number[],
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    TrimmerService: { Defaults: async () => ({}), Enqueue: (...a: unknown[]) => h.enqueue(...a) },
    MediaService: {
      Keyframes: (p: string) => h.keyframes(p),
      Filmstrip: async () => "/media/t/strip.jpg",
      Waveform: async () => [0.1, 0.2],
    },
    JobsService: { Cancel: async () => undefined },
    ModulesService: { Match: async () => ({ matches: [] }) },
    FilesService: {
      Pick: async () => ["/clip.mp4"],
      Stat: async (p: string[]) => p.map((path) => ({ path, name: "clip.mp4", sizeBytes: 100 * 1024 * 1024, exists: true, isDir: false, kind: "video" })),
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: (...a: unknown[]) => h.setState(...a) },
  };
});

vi.mock("@/components/media", async (orig) => {
  const actual = await orig<typeof import("@/components/media")>();
  const React = await import("react");
  return {
    ...actual,
    useMediaSource: () => ({ retry: vi.fn(), ...h.media.current }),
    MediaPlayer: React.forwardRef(function MediaPlayerStub(_p: unknown, ref: React.Ref<unknown>) {
      React.useImperativeHandle(ref, () => ({
        play() {},
        pause() {},
        toggle() {},
        seek(ms: number) {
          h.seeks.push(ms);
        },
        step() {},
        currentMs: () => h.playerMs.value,
        playing: () => false,
      }));
      return <div data-testid="player" />;
    }),
    Timeline: (p: { ranges?: { id: string; label?: string }[]; keyframes?: number[] }) => (
      <div data-testid="timeline" data-keyframes={p.keyframes ? p.keyframes.length : "none"}>
        {(p.ranges ?? []).map((r) => (
          <span key={r.id}>range {r.label}</span>
        ))}
      </div>
    ),
    CropOverlay: () => <div data-testid="crop" />,
  };
});

import { useToastStore } from "@/components/toast";
import { useJobs } from "@/state/jobs";
import { JobStatus, type Job, type MediaSource } from "@/lib/api";
import { trimmerCommands } from "./commands";
import TrimmerView from "./TrimmerView";

const source = (video: boolean): MediaSource =>
  ({
    url: "/media/t/clip.mp4",
    proxy: false,
    proxyJobId: "",
    info: {
      durationMs: 10_000,
      startMs: 0,
      container: "mp4",
      sizeBytes: 100 * 1024 * 1024,
      bitRate: 0,
      video: video ? { index: 0, codec: "h264", width: 1920, height: 1080, fps: 25, rotation: 0, pixFmt: "yuv420p" } : null,
      audio: null,
      subtitles: null,
      hasCover: false,
      tags: null,
    },
  }) as MediaSource;

async function load() {
  const user = userEvent.setup();
  render(<TrimmerView moduleId="trimmer" />);
  await user.click(screen.getByRole("button", { name: "Choose file" }));
  return user;
}

const startField = (n: number) => screen.getByLabelText(`Segment ${n} start`) as HTMLInputElement;
const endField = (n: number) => screen.getByLabelText(`Segment ${n} end`) as HTMLInputElement;

describe("TrimmerView", () => {
  beforeEach(() => {
    h.enqueue.mockReset();
    h.setState.mockClear();
    h.keyframes.mockClear();
    h.seeks.length = 0;
    h.playerMs.value = 0;
    h.media.current = { status: "ready", source: source(true) };
    useToastStore.setState({ toasts: [] });
    useJobs.setState({ byId: {} });
  });

  it("shows the empty state", () => {
    render(<TrimmerView moduleId="trimmer" />);
    expect(screen.getByText("Drop a video or audio file")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose file" })).toBeTruthy();
  });

  it("opens a file with one segment covering it and a summary", async () => {
    await load();
    expect(await screen.findByTestId("player")).toBeTruthy();
    expect(startField(1).value).toBe("0:00.000");
    expect(endField(1).value).toBe("0:10.000");
    expect(screen.getByText("1 segment · 0:10 total · ≈ 100 MB")).toBeTruthy();
    expect(screen.getByText("range 1")).toBeTruthy();
  });

  it("I and O set the selected segment from the playhead", async () => {
    const user = await load();
    await screen.findByTestId("player");
    h.playerMs.value = 2000;
    await user.keyboard("i");
    expect(startField(1).value).toBe("0:02.000");
    h.playerMs.value = 6500;
    await user.keyboard("o");
    expect(endField(1).value).toBe("0:06.500");
    // O cannot go before the start.
    h.playerMs.value = 1000;
    await user.keyboard("o");
    expect(endField(1).value).toBe("0:02.100");
  });

  it("adds segments without overlap and deletes them", async () => {
    const user = await load();
    await screen.findByTestId("player");
    h.playerMs.value = 2000;
    await user.keyboard("o"); // segment 1: 0 to 2 s
    h.playerMs.value = 3000;
    await user.keyboard("+");
    expect(screen.getByText("range 2")).toBeTruthy();
    expect(startField(2).value).toBe("0:03.000");
    expect(endField(2).value).toBe("0:08.000");
    // Inside segment 2: the next one starts after it.
    h.playerMs.value = 4000;
    await user.click(screen.getByRole("button", { name: /Add segment/ }));
    expect(startField(3).value).toBe("0:08.000");
    expect(endField(3).value).toBe("0:10.000");
    expect(screen.getByLabelText("Join")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete segment 3" }));
    expect(screen.queryByLabelText("Segment 3 start")).toBeNull();
  });

  it("selecting a row seeks to its start", async () => {
    const user = await load();
    await screen.findByTestId("player");
    h.playerMs.value = 2000;
    await user.keyboard("o");
    h.playerMs.value = 3000;
    await user.keyboard("+");
    h.seeks.length = 0;
    await user.click(screen.getByText("1"));
    expect(h.seeks.at(-1)).toBe(0);
  });

  it("typing a timecode edits a segment", async () => {
    const user = await load();
    await screen.findByTestId("player");
    await user.clear(endField(1));
    await user.type(endField(1), "1:05{Enter}");
    // beyond the file: clamped to the duration
    expect(endField(1).value).toBe("0:10.000");
    await user.clear(endField(1));
    await user.type(endField(1), "4.5{Enter}");
    expect(endField(1).value).toBe("0:04.500");
  });

  it("notes fast-mode keyframe shifts", async () => {
    const user = await load();
    await screen.findByTestId("player");
    await waitFor(() => expect(h.keyframes).toHaveBeenCalledWith("/clip.mp4"));
    h.playerMs.value = 4400;
    await user.keyboard("i");
    expect(await screen.findByText("starts 1.4 s earlier (keyframe)")).toBeTruthy();
    expect(screen.getByTestId("timeline").getAttribute("data-keyframes")).toBe("3");
    // Precise mode has no keyframe notes.
    await user.click(screen.getByRole("radio", { name: "Precise · re-encode" }));
    expect(screen.queryByText(/earlier \(keyframe\)/)).toBeNull();
  });

  it("choosing a frame switches to Precise, toasts, shows the crop overlay and persists", async () => {
    const user = await load();
    await screen.findByTestId("player");
    expect((screen.getByRole("radio", { name: "Fast · no quality loss" }) as HTMLInputElement).getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("radio", { name: "9:16" }));
    expect(screen.getByRole("radio", { name: "Precise · re-encode" }).getAttribute("aria-checked")).toBe("true");
    expect(useToastStore.getState().toasts.map((t) => t.title)).toContain("Switched to Precise — cropping re-encodes");
    await waitFor(() => expect(JSON.parse(String(h.setState.mock.calls.at(-1)?.[1]))).toMatchObject({ mode: "precise", aspect: "9:16" }));
  });

  it("estimate text follows mode and limit", async () => {
    const user = await load();
    await screen.findByTestId("player");
    await user.click(screen.getByRole("radio", { name: "Precise · re-encode" }));
    expect(screen.getByText(/size depends on the content/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Size limit"), "25");
    expect(screen.getByText(/≈ 25 MB/)).toBeTruthy();
  });

  it("exports the segments and shows progress, then the result", async () => {
    h.enqueue.mockResolvedValue([{ id: "j1" }]);
    const user = await load();
    await screen.findByTestId("player");
    h.playerMs.value = 4000;
    await user.keyboard("o");
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await waitFor(() =>
      expect(h.enqueue).toHaveBeenCalledWith(["/clip.mp4"], expect.objectContaining({ mode: "fast", segments: [{ startMs: 0, endMs: 4000 }] })),
    );
    const base = { id: "j1", moduleId: "trimmer", title: "t", progress: 0.4, message: "Cutting", inputs: [], outputs: [], resultJson: "" } as unknown as Job;
    act(() => useJobs.getState().upsert({ ...base, status: JobStatus.JobRunning }));
    expect(await screen.findByRole("progressbar", { name: "Export progress" })).toBeTruthy();
    expect(screen.getByText("Cutting")).toBeTruthy();
    act(() =>
      useJobs.getState().upsert({
        ...base,
        status: JobStatus.JobDone,
        progress: 1,
        resultJson: JSON.stringify({ outputs: ["/o.mp4"], maxShiftMs: 1400 }),
        outputs: [{ id: "o1", jobId: "j1", moduleId: "trimmer", path: "/o.mp4", name: "clip (trim).mp4", kind: "video", sizeBytes: 1000, createdAt: 0, tags: null, missing: false }],
      } as unknown as Job),
    );
    expect(await screen.findByText("clip (trim).mp4")).toBeTruthy();
    expect(screen.getByText(/moved a cut up to 1.4 s earlier/)).toBeTruthy();
  });

  it("shows a submit error", async () => {
    h.enqueue.mockRejectedValue({ cause: JSON.stringify({ code: "validation", message: "Too long to fit", hint: "Raise the limit" }) });
    const user = await load();
    await screen.findByTestId("player");
    await user.click(screen.getByRole("button", { name: /Export/ }));
    expect(await screen.findByText("Too long to fit")).toBeTruthy();
    expect(screen.getByText("Raise the limit")).toBeTruthy();
  });

  it("shows the preview-copy placeholder", async () => {
    h.media.current = { status: "preparing", progress: 0.42 };
    await load();
    expect(await screen.findByText(/Preparing a preview copy… 42%/)).toBeTruthy();
    expect(screen.getByText(/Your export uses the original/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Export/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a probe error banner", async () => {
    h.media.current = { status: "error", error: { code: "internal", message: "Not a media file", hint: "Pick another" } };
    await load();
    expect(await screen.findByText("Not a media file")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("audio-only files hide the picture options", async () => {
    h.media.current = { status: "ready", source: source(false) };
    await load();
    await screen.findByTestId("player");
    expect(screen.queryByLabelText("Frame")).toBeNull();
    expect(screen.queryByText("Remove audio")).toBeNull();
    expect(screen.getByTestId("timeline").getAttribute("data-keyframes")).toBe("none");
  });

  it("palette commands drive the view", async () => {
    await load();
    await screen.findByTestId("player");
    h.playerMs.value = 3000;
    const cmds = trimmerCommands();
    act(() => cmds.find((c) => c.id === "trimmer.set-end")?.run());
    expect(endField(1).value).toBe("0:03.000");
    expect(cmds.map((c) => c.id)).toEqual(["trimmer.choose-file", "trimmer.set-start", "trimmer.set-end", "trimmer.add-segment", "trimmer.export"]);
  });

  it("ignores I/O while typing in a field", async () => {
    const user = await load();
    await screen.findByTestId("player");
    h.playerMs.value = 2000;
    fireEvent.focus(startField(1));
    await user.click(startField(1));
    await user.keyboard("i");
    expect(startField(1).value).toBe("i");
  });
});
