import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enqueue: vi.fn(),
  cancel: vi.fn(async (_id: string) => undefined),
  setState: vi.fn(async (..._a: unknown[]) => undefined),
  pick: { paths: ["/photo.jpg"] as string[] },
  media: { current: { status: "ready" } as Record<string, unknown> },
  install: vi.fn(async (_id: string) => ({ id: "inst", moduleId: "system-pack-install", status: "queued" })),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    RedactService: { Defaults: async () => ({}), Enqueue: (...a: unknown[]) => h.enqueue(...a) },
    MediaService: { URLFor: async (p: string) => `/media/t/${p.split("/").pop()}` },
    JobsService: { Cancel: (id: string) => h.cancel(id) },
    PacksService: { InstallFor: (id: string) => h.install(id) },
    FilesService: {
      Pick: async () => h.pick.paths,
      ImageThumb: async () => "data:image/jpeg;base64,AAAA",
      Stat: async (p: string[]) => p.map((path) => ({ path, name: path.split("/").pop(), sizeBytes: 1000, exists: true, isDir: false, kind: "image" })),
    },
    LibraryService: { Reveal: async () => undefined, RevealPath: async () => undefined, Open: async () => undefined },
    SettingsService: { ModuleState: async () => "", SetModuleState: (...a: unknown[]) => h.setState(...a) },
  };
});

vi.mock("@/components/media", async (orig) => {
  const actual = await orig<typeof import("@/components/media")>();
  const React = await import("react");
  return {
    ...actual,
    useMediaSource: () => ({ retry: vi.fn(), ...h.media.current }),
    MediaPlayer: React.forwardRef(function MediaPlayerStub(p: { overlay?: (r: { left: number; top: number; width: number; height: number }) => React.ReactNode }, ref: React.Ref<unknown>) {
      React.useImperativeHandle(ref, () => ({ play() {}, pause() {}, toggle() {}, seek() {}, step() {}, currentMs: () => 500, playing: () => false }));
      return <div data-testid="player">{p.overlay?.({ left: 0, top: 0, width: 400, height: 300 })}</div>;
    }),
    Timeline: (p: { markers?: { id: string; label?: string }[] }) => (
      <div data-testid="timeline">
        {(p.markers ?? []).map((m) => (
          <span key={m.id}>marker {m.label}</span>
        ))}
      </div>
    ),
  };
});

import { JobStatus, PackComponentState, PackState } from "@/lib/api";
import { useToastStore } from "@/components/toast";
import { useJobs, type JobView } from "@/state/jobs";
import { usePacks } from "@/state/packs";
import { redactCommands } from "./commands";
import RedactView from "./RedactView";

const job = (over: Partial<JobView>): JobView =>
  ({ id: "j1", moduleId: "redact", status: JobStatus.JobRunning, progress: 0.3, message: "Looking at 1 of 2", error: "", errorHint: "", resultJson: "", inputs: [], outputs: [], ...over }) as unknown as JobView;

const face = (id: string, over: Record<string, unknown> = {}) => ({ id, x: 0.1, y: 0.1, w: 0.2, h: 0.2, kind: "face", enabled: true, score: 0.9, ...over });
const detectDone = (images: unknown[]) => job({ status: JobStatus.JobDone, progress: 1, resultJson: JSON.stringify({ action: "detect", images, video: null, outputs: [] }) });

async function load(paths: string[] = ["/photo.jpg"]) {
  h.pick.paths = paths;
  const user = userEvent.setup();
  render(<RedactView moduleId="redact" />);
  await user.click(screen.getByRole("button", { name: "Choose files" }));
  return user;
}

const lastOpts = () => h.enqueue.mock.calls.at(-1)?.[1] as Record<string, unknown>;
const finish = (j: JobView) => act(() => useJobs.setState({ byId: { [j.id]: j } }));

describe("RedactView", () => {
  beforeEach(() => {
    h.enqueue.mockReset();
    h.enqueue.mockResolvedValue([{ id: "j1", moduleId: "redact", status: "queued", progress: 0, inputs: [], outputs: [] }]);
    h.cancel.mockClear();
    h.setState.mockClear();
    h.install.mockClear();
    h.media.current = { status: "ready" };
    useToastStore.setState({ toasts: [] });
    useJobs.setState({ byId: {} });
    usePacks.setState({ list: [], byId: {}, loaded: false });
  });

  it("shows the empty state with the always-visible warning", () => {
    render(<RedactView moduleId="redact" />);
    expect(screen.getByText("Drop photos or one video")).toBeTruthy();
    expect(screen.getByText(/Detection can miss faces and plates/)).toBeTruthy();
  });

  it("shows options after choosing a photo and sends the detect job", async () => {
    const user = await load();
    expect(await screen.findByRole("radio", { name: "Pixelate" })).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "High" }));
    await user.click(screen.getByRole("button", { name: "Find faces and plates" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(1));
    expect(h.enqueue.mock.calls[0]?.[0]).toEqual(["/photo.jpg"]);
    expect(lastOpts()).toMatchObject({ action: "detect", faces: true, plates: true, sensitivity: "high", style: "blur", strength: 6, padding: 15, stripMetadata: true });
  });

  it("shows progress with Cancel while detecting", async () => {
    const user = await load();
    await user.click(screen.getByRole("button", { name: "Find faces and plates" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalled());
    finish(job({}));
    expect(await screen.findByText("Looking at 1 of 2")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Progress" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(h.cancel).toHaveBeenCalledWith("j1");
  });

  it("shows the job's error and keeps the options when detection fails", async () => {
    const user = await load();
    await user.click(screen.getByRole("button", { name: "Find faces and plates" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalled());
    finish(job({ status: JobStatus.JobFailed, error: "Face model missing", errorHint: "Install the models" }));
    expect(await screen.findByText("Face model missing")).toBeTruthy();
    expect(screen.getByText("Install the models")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Blur" })).toBeTruthy();
  });

  it("reviews one image straight away; dropping a box then saving sends the edited boxes", async () => {
    const user = await load();
    await user.click(screen.getByRole("button", { name: "Find faces and plates" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalled());
    finish(detectDone([{ path: "/photo.jpg", width: 2000, height: 1000, boxes: [face("f1"), face("f2", { x: 0.5, score: 0.63 }), { ...face("p1", { kind: "plate", score: 0.5 }), x: 0.7 }] }]));

    expect(await screen.findByText("2 faces · 1 plate")).toBeTruthy();
    await user.click(screen.getByRole("switch", { name: "Redact box 2" }));
    expect(screen.getByText("1 face · 1 plate")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete box 3" }));
    expect(screen.getByText("1 face")).toBeTruthy();

    h.enqueue.mockClear();
    await user.click(screen.getByRole("button", { name: /Save redacted/ }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(1));
    expect(h.enqueue.mock.calls[0]?.[0]).toEqual(["/photo.jpg"]);
    const opts = lastOpts() as { action: string; imageBoxes: Record<string, Array<{ id: string; enabled: boolean }>> };
    expect(opts.action).toBe("apply");
    expect(opts.imageBoxes["/photo.jpg"]?.map((b) => [b.id, b.enabled])).toEqual([
      ["f1", true],
      ["f2", false],
    ]);
  });

  it("toggles a box by clicking it in the picture and adds a manual box by drawing", async () => {
    const user = await load();
    await user.click(screen.getByRole("button", { name: "Find faces and plates" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalled());
    finish(detectDone([{ path: "/photo.jpg", width: 2000, height: 1000, boxes: [face("f1")] }]));
    await screen.findByText("1 face");
    fireEvent.click(await screen.findByTestId("box-f1"));
    expect(screen.getByText("Nothing to hide")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Save redacted/ }) as HTMLButtonElement).disabled).toBe(true);

    await user.keyboard("b");
    expect(screen.getByRole("button", { name: /Add box/ }).getAttribute("aria-pressed")).toBe("true");
    const overlay = screen.getByTestId("box-overlay");
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(overlay, { button: 0, clientX: 40, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(overlay, { clientX: 200, clientY: 150, pointerId: 1 });
    fireEvent.pointerUp(overlay, { clientX: 200, clientY: 150, pointerId: 1 });
    expect(await screen.findByText("1 manual box")).toBeTruthy();
  });

  it("shows a gallery for several images, opens one, and redacts all with the current boxes", async () => {
    const user = await load(["/a.jpg", "/b.jpg"]);
    await user.click(screen.getByRole("button", { name: "Find in 2 images" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalled());
    expect(h.enqueue.mock.calls[0]?.[0]).toEqual(["/a.jpg", "/b.jpg"]);
    finish(
      detectDone([
        { path: "/a.jpg", width: 100, height: 100, boxes: [face("a1"), face("a2"), { ...face("a3"), kind: "plate" }] },
        { path: "/b.jpg", width: 100, height: 100, boxes: [] },
      ]),
    );
    const gallery = await screen.findByRole("list", { name: "Detections per image" });
    expect(within(gallery).getByText("2 faces · 1 plate")).toBeTruthy();
    expect(within(gallery).getByText("Nothing to hide")).toBeTruthy();

    await user.click(within(gallery).getByRole("listitem", { name: "a.jpg" }));
    expect(await screen.findByText(/a\.jpg · 1 of 2/)).toBeTruthy();
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByText(/b\.jpg · 2 of 2/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "All images" }));
    const items = screen.getAllByRole("listitem");
    expect(items.length).toBe(2);

    await user.click(screen.getByRole("button", { name: /^Redact all 2/ }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(2));
    const opts = lastOpts() as { imageBoxes: Record<string, unknown[]> };
    expect(Object.keys(opts.imageBoxes)).toEqual(["/a.jpg", "/b.jpg"]);
    expect(opts.imageBoxes["/a.jpg"]).toHaveLength(3);
    expect(opts.imageBoxes["/b.jpg"]).toEqual([]);
  });

  it("shows result cards after apply", async () => {
    const user = await load();
    await user.click(screen.getByRole("button", { name: "Redact without review" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalled());
    expect(lastOpts()).toMatchObject({ action: "auto" });
    finish(job({ status: JobStatus.JobDone, progress: 1, resultJson: JSON.stringify({ action: "auto", outputs: ["/out/photo (redacted).jpg"] }), outputs: [{ id: "o1", path: "/out/photo (redacted).jpg", name: "photo (redacted).jpg", sizeBytes: 2048 }] as never }));
    const card = await screen.findByTestId("result-card");
    expect(within(card).getByText("photo (redacted).jpg")).toBeTruthy();
    expect(within(card).getByRole("button", { name: /Open/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Redact more" }));
    expect(screen.getByText("Drop photos or one video")).toBeTruthy();
  });

  it("offers only the automatic path for HEIC photos", async () => {
    await load(["/photo.heic"]);
    expect((await screen.findByRole("button", { name: "Find faces and plates" })).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/HEIC photos can't be previewed here/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Redact without review" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers to install missing models and blocks detection until they are there", async () => {
    const { useDeps } = await import("@/state/deps");
    useDeps.setState({ list: [{ id: "audio-engine", state: "ok" }] as never, byId: { "audio-engine": { id: "audio-engine", state: "ok" } } as never });
    usePacks.setState({
      loaded: true,
      list: [
        {
          id: "redact-pack",
          state: PackState.PackPartial,
          components: [
            { id: "face-detect", state: PackComponentState.ComponentMissing },
            { id: "plate-detect", state: PackComponentState.ComponentInstalled },
          ],
        },
      ] as never,
    });
    const user = await load();
    expect(await screen.findByText("Redact needs its detection models")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Find faces and plates" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Install the models" }));
    await waitFor(() => expect(h.install).toHaveBeenCalledWith("redact"));
    useDeps.setState({ list: [], byId: {} });
  });

  it("rejects a mix of photos and a video", async () => {
    await load(["/a.jpg", "/b.mp4"]);
    expect(await screen.findByText("Redact images and videos separately")).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Find/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reviews a video: tracks, false positives off, manual box, and sends the detections path back", async () => {
    h.media.current = {
      status: "ready",
      source: { url: "/media/t/clip.mp4", proxy: false, proxyJobId: "", info: { durationMs: 10_000, startMs: 0, container: "mp4", sizeBytes: 1, bitRate: 0, video: { index: 0, codec: "h264", width: 1920, height: 1080, fps: 25, rotation: 0, pixFmt: "yuv420p" }, audio: null, subtitles: null, hasCover: false, tags: null } },
    };
    const user = await load(["/clip.mp4"]);
    await user.click(screen.getByRole("button", { name: "Find faces and plates" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalled());
    expect(h.enqueue.mock.calls[0]?.[0]).toEqual(["/clip.mp4"]);
    const samples = [
      { ms: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      { ms: 1000, x: 0.3, y: 0.1, w: 0.2, h: 0.2 },
    ];
    const tracks = [
      { id: "t1", kind: "face", startMs: 0, endMs: 1000, maxScore: 0.95, enabled: true, samples },
      { id: "t2", kind: "plate", startMs: 2000, endMs: 3000, maxScore: 0.4, enabled: false, samples: samples.map((s) => ({ ...s, ms: s.ms + 2000 })) },
    ];
    finish(job({ status: JobStatus.JobDone, progress: 1, resultJson: JSON.stringify({ action: "detect", images: [], video: { detectionsPath: "/cache/redact/j1.json", width: 1920, height: 1080, durationMs: 10_000, tracks }, outputs: [] }) }));

    expect(await screen.findByText("1 of 2 tracks on")).toBeTruthy();
    expect(screen.getByText("marker Face 1")).toBeTruthy();
    expect(screen.getByTestId("box-t1")).toBeTruthy(); // the stub player sits at 500 ms
    expect(screen.queryByTestId("box-t2")).toBeNull();

    await user.click(screen.getByRole("switch", { name: "Redact track 2" }));
    expect(screen.getByText("2 of 2 tracks on")).toBeTruthy();
    await user.click(screen.getByRole("switch", { name: "Redact track 1" }));
    expect(screen.getByText("1 of 2 tracks on")).toBeTruthy();
    await user.click(screen.getByRole("switch", { name: "Redact track 1" }));

    await user.keyboard("b");
    const overlay = screen.getByTestId("box-overlay");
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(overlay, { button: 0, clientX: 200, clientY: 150, pointerId: 1 });
    fireEvent.pointerUp(overlay, { clientX: 300, clientY: 250, pointerId: 1 });
    expect(await screen.findByLabelText("Manual box 1 start")).toBeTruthy();
    expect((screen.getByLabelText("Manual box 1 end") as HTMLInputElement).value).toBe("0:03.500");

    h.enqueue.mockClear();
    await user.click(screen.getByRole("button", { name: /^Redact video/ }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(1));
    expect(h.enqueue.mock.calls[0]?.[0]).toEqual(["/clip.mp4"]);
    const opts = lastOpts() as { action: string; detectionsPath: string; disabledTracks: string[]; manualBoxes: Array<{ startMs: number; endMs: number }> };
    expect(opts).toMatchObject({ action: "apply", detectionsPath: "/cache/redact/j1.json", disabledTracks: [] });
    expect(opts.manualBoxes).toHaveLength(1);
    expect(opts.manualBoxes[0]).toMatchObject({ startMs: 500, endMs: 3500 });
  });

  it("registers palette entries", () => {
    expect(redactCommands().map((c) => c.id)).toEqual(["redact.choose-file", "redact.detect", "redact.apply", "redact.add-box"]);
  });
});
