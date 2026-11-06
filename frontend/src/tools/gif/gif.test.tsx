import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const playhead = vi.hoisted(() => ({ ms: 0 }));

vi.mock("@/components/media", async (orig) => {
  const actual = await orig<typeof import("@/components/media")>();
  const React = await import("react");
  return {
    ...actual,
    useMediaSource: () => ({
      retry: () => undefined,
      status: "ready",
      source: { url: "/media/t/a.mp4", info: { durationMs: 83_000 } },
    }),
    MediaPlayer: React.forwardRef(function MediaPlayerStub(_p: object, ref: React.Ref<unknown>) {
      React.useImperativeHandle(ref, () => ({ currentMs: () => playhead.ms }));
      return <div data-testid="player" />;
    }),
  };
});

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    GifService: { Enqueue: (...a: unknown[]) => enqueue(...a) },
    MediaService: { URLFor: async (p: string) => `/media/token/${p.split("/").pop()}` },
    FilesService: {
      Pick: async () => ["/a.mp4"],
      ImageThumb: async () => "data:image/jpeg;base64,AAAA",
      Stat: async (p: string[]) => p.map((path) => ({ path, name: path, sizeBytes: 10, exists: true, isDir: false, kind: "video" })),
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    LibraryService: { Reveal: async () => undefined, Open: async () => undefined, RevealPath: async () => undefined },
  };
});

import { ErrorCode, GifMode, JobStatus } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import GifView from "./GifView";
import { DEFAULT_GIF_OPTIONS, lengthFromEnd, sanitizeGifOptions, tenthsOfSecond, toGifResult } from "./options";

function job(id: string, outPath: string, result: Record<string, unknown>) {
  return {
    id,
    moduleId: "gif",
    title: "a.mp4",
    status: JobStatus.JobDone,
    progress: 1,
    message: "",
    inputs: ["/a.mp4"],
    optionsJson: "{}",
    errorCode: ErrorCode.$zero,
    error: "",
    errorHint: "",
    pipelineRunId: "",
    pipelineStepId: "",
    attempt: 1,
    cancelRequested: false,
    createdAt: 1,
    startedAt: 1,
    finishedAt: 2,
    outputs: [{ id: `o-${id}`, path: outPath, missing: false }] as never,
    resultJson: JSON.stringify({ outputs: [outPath], ...result }),
  };
}

describe("gif options", () => {
  it("sanitizes saved options", () => {
    expect(sanitizeGifOptions({ mode: "sheet", columns: 10, rows: 10, labels: false, fps: 99, lengthSec: 100 }, DEFAULT_GIF_OPTIONS)).toEqual({
      ...DEFAULT_GIF_OPTIONS,
      mode: "sheet",
      columns: 10,
      rows: 10,
      labels: false,
      fps: 30,
      lengthSec: 30,
    });
    expect(sanitizeGifOptions({ mode: "mp4", columns: 8, rows: 20 }, DEFAULT_GIF_OPTIONS)).toEqual({ ...DEFAULT_GIF_OPTIONS, columns: 8, rows: 10 });
    expect(sanitizeGifOptions(null, DEFAULT_GIF_OPTIONS)).toEqual(DEFAULT_GIF_OPTIONS);
  });

  it("describes results", () => {
    const g = toGifResult(job("j", "/o/a.gif", { mode: "gif", durationMs: 4000, width: 480, height: 270, sizeBytes: 2 << 20 }) as never);
    expect(g?.meta).toBe("4.0 s · 480 × 270 · 2.0 MB");
    const s = toGifResult(job("j", "/o/a (sheet).jpg", { mode: "sheet", frames: 16, sizeBytes: 300_000 }) as never);
    expect(s?.mode).toBe(GifMode.ModeSheet);
    expect(s?.meta).toBe("16 frames · 293 KB");
    expect(toGifResult({ ...job("j", "/o/a.gif", {}), resultJson: "" } as never)).toBeNull();
  });
});

describe("GifView", () => {
  beforeEach(() => {
    enqueue.mockReset();
    useJobs.setState({ byId: {} });
  });

  it("switches to a contact sheet and enqueues its grid", async () => {
    enqueue.mockResolvedValue([{}]);
    const user = userEvent.setup();
    render(<GifView moduleId="gif" />);
    expect(await screen.findByLabelText("Length")).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "Contact sheet" }));
    expect(screen.queryByLabelText("Length")).toBeNull();
    expect(screen.getByLabelText("Columns")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add files…" }));
    const run = await screen.findByRole("button", { name: /Make a sheet from/ });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    await user.click(run);
    await waitFor(() => expect(enqueue).toHaveBeenCalledWith(["/a.mp4"], expect.objectContaining({ mode: "sheet", columns: 4, rows: 4, labels: true })));
  });

  it("shows the video with its duration and sets start and end from the playhead", async () => {
    enqueue.mockResolvedValue([{}]);
    const user = userEvent.setup();
    render(<GifView moduleId="gif" />);
    await user.click(await screen.findByRole("button", { name: "Add files…" }));
    expect(await screen.findByTestId("player")).toBeTruthy();
    expect(screen.getByText("1:23")).toBeTruthy();
    playhead.ms = 12_340;
    await user.click(screen.getByRole("button", { name: "Set start here" }));
    expect((screen.getByLabelText("Start") as HTMLInputElement).value).toContain("12.3");
    playhead.ms = 17_340;
    await user.click(screen.getByRole("button", { name: "Set end here" }));
    expect((screen.getByLabelText("Length") as HTMLInputElement).value).toContain("5");
    const run = await screen.findByRole("button", { name: /Make a GIF from/ });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    await user.click(run);
    await waitFor(() => expect(enqueue).toHaveBeenCalledWith(["/a.mp4"], expect.objectContaining({ startSec: 12.3, lengthSec: 5 })));
    // The video stays queued after the run, so a tweak can run again.
    expect(screen.getByRole("list", { name: "Input files" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
  });

  it("converts a playhead into start and length", () => {
    expect(tenthsOfSecond(12.34)).toBe(12.3);
    expect(lengthFromEnd(12.3, 17.34)).toBe(5);
    expect(lengthFromEnd(12.3, 12.3)).toBeNull();
    expect(lengthFromEnd(2, 1)).toBeNull();
    expect(lengthFromEnd(0, 120)).toBe(30);
    expect(lengthFromEnd(1, 1.2)).toBe(0.5);
  });

  it("previews a GIF inline and a sheet as an image card", async () => {
    useJobs.getState().upsert(job("j1", "/o/a.gif", { mode: "gif", durationMs: 3000, width: 320, height: 180, sizeBytes: 1000 }) as never);
    useJobs.getState().upsert(job("j2", "/o/b (sheet).jpg", { mode: "sheet", frames: 6, sizeBytes: 50_000 }) as never);
    render(<GifView moduleId="gif" />);
    expect(await screen.findByAltText("Preview of a.gif")).toBeTruthy();
    expect(await screen.findByAltText("Contact sheet of a.mp4")).toBeTruthy();
    expect(screen.getByText("6 frames · 49 KB")).toBeTruthy();
  });
});
