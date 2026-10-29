import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  erase: vi.fn(),
  cancel: vi.fn(async (_id: string) => undefined),
  urlFor: vi.fn(async (p: string) => `/media/t/${p.split("/").pop()}`),
  thumb: vi.fn(async (_p: string, _max: number) => "data:image/jpeg;base64,AAAA"),
  pick: { paths: ["/photo.jpg"] as string[] },
  setState: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    EraserService: {
      Defaults: async () => ({}),
      ModelStatus: async () => [
        { id: "best", label: "Best", downloadBytes: 208 * 1024 * 1024, present: false },
        { id: "fast", label: "Fast", downloadBytes: 28 * 1024 * 1024, present: true },
      ],
      Erase: (...a: unknown[]) => h.erase(...a),
    },
    MediaService: { URLFor: (p: string) => h.urlFor(p) },
    JobsService: { Cancel: (id: string) => h.cancel(id) },
    FilesService: {
      Pick: async () => h.pick.paths,
      ImageThumb: (p: string, max: number) => h.thumb(p, max),
      Stat: async (p: string[]) => p.map((path) => ({ path, name: path.split("/").pop(), sizeBytes: 1000, exists: true, isDir: false, kind: "image" })),
    },
    LibraryService: { Reveal: async () => undefined, RevealPath: async () => undefined, Open: async () => undefined },
    SettingsService: { ModuleState: async () => "", SetModuleState: (...a: unknown[]) => h.setState(...a) },
  };
});

import { useToastStore } from "@/components/toast";
import { JobStatus } from "@/lib/api";
import { useJobs, type JobView } from "@/state/jobs";
import { eraserCommands } from "./commands";
import ObjectEraserView from "./ObjectEraserView";

const proto = HTMLCanvasElement.prototype;
const origGetContext = proto.getContext;
const origToDataURL = proto.toDataURL;
const origRect = proto.getBoundingClientRect;

function fakeCtx() {
  const noop = () => undefined;
  return new Proxy({ getImageData: () => ({ data: new Uint8ClampedArray([255, 255, 255, 255]) }) } as Record<string, unknown>, {
    get: (t, k: string) => (k in t ? t[k] : noop),
    set: () => true,
  });
}

const job = (over: Partial<JobView>): JobView =>
  ({
    id: "j1",
    moduleId: "object-eraser",
    status: "running",
    progress: 0.4,
    message: "Loading model (the first run takes a while)",
    error: "",
    errorHint: "",
    resultJson: "",
    inputs: ["/photo.jpg"],
    outputs: [],
    ...over,
  }) as unknown as JobView;

async function load(path = "/photo.jpg") {
  h.pick.paths = [path];
  const user = userEvent.setup();
  render(<ObjectEraserView moduleId="object-eraser" />);
  await user.click(screen.getByRole("button", { name: "Choose photo" }));
  return user;
}

async function loaded() {
  const user = await load();
  const img = (await screen.findByAltText("Photo to edit")) as HTMLImageElement;
  Object.defineProperty(img, "naturalWidth", { value: 2000 });
  Object.defineProperty(img, "naturalHeight", { value: 1000 });
  fireEvent.load(img);
  return user;
}

const paint = () => {
  const stage = screen.getByTestId("stage");
  fireEvent.pointerDown(stage, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(stage, { clientX: 150, clientY: 120, pointerId: 1 });
  fireEvent.pointerUp(stage, { pointerId: 1 });
};

describe("ObjectEraserView", () => {
  beforeEach(() => {
    h.erase.mockReset();
    h.cancel.mockClear();
    h.urlFor.mockClear();
    h.setState.mockClear();
    useToastStore.setState({ toasts: [] });
    useJobs.setState({ byId: {} });
    proto.getContext = (() => fakeCtx()) as unknown as typeof proto.getContext;
    proto.toDataURL = () => "data:image/png;base64,QUJD";
    proto.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
  });
  afterEach(() => {
    proto.getContext = origGetContext;
    proto.toDataURL = origToDataURL;
    proto.getBoundingClientRect = origRect;
  });

  it("shows the empty state", () => {
    render(<ObjectEraserView moduleId="object-eraser" />);
    expect(screen.getByText("Drop a photo")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose photo" })).toBeTruthy();
  });

  it("opens the photo with tools, model hint and a disabled Erase", async () => {
    await loaded();
    expect(screen.getByLabelText("Painting tools")).toBeTruthy();
    expect(screen.getByText(/Best · 208 MB · Fast · 28 MB/)).toBeTruthy();
    expect(await screen.findByText(/downloads 208 MB on first use/)).toBeTruthy();
    const erase = screen.getByRole("button", { name: /^Erase/ }) as HTMLButtonElement;
    expect(erase.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("painting enables Erase, Undo and Clear; undo disables them again", async () => {
    const user = await loaded();
    paint();
    expect((screen.getByRole("button", { name: /^Erase/ }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Clear mask" }) as HTMLButtonElement).disabled).toBe(false);
    await user.keyboard("{Control>}z{/Control}");
    expect((screen.getByRole("button", { name: /^Erase/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    expect((screen.getByRole("button", { name: /^Erase/ }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "Clear mask" }));
    expect((screen.getByRole("button", { name: /^Erase/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("B and E switch tools", async () => {
    const user = await loaded();
    await user.keyboard("e");
    expect(screen.getByRole("radio", { name: "Unpaint" }).getAttribute("aria-checked")).toBe("true");
    await user.keyboard("b");
    expect(screen.getByRole("radio", { name: "Brush" }).getAttribute("aria-checked")).toBe("true");
  });

  it("sends the mask PNG and the chosen model to Erase", async () => {
    h.erase.mockResolvedValue({ id: "j1" });
    const user = await loaded();
    await user.click(screen.getByRole("radio", { name: "Fast" }));
    paint();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(h.erase).toHaveBeenCalledTimes(1));
    expect(h.erase).toHaveBeenCalledWith("/photo.jpg", "data:image/png;base64,QUJD", { model: "fast", maskPath: "" });
  });

  it("shows stage text and progress with Cancel while running", async () => {
    h.erase.mockResolvedValue({ id: "j1" });
    const user = await loaded();
    paint();
    await user.click(screen.getByRole("button", { name: /^Erase/ }));
    act(() => useJobs.setState({ byId: { j1: job({}) } }));
    expect(await screen.findByText("Loading model (the first run takes a while)")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Erase progress" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(h.cancel).toHaveBeenCalledWith("j1");
  });

  it("shows the server's error and keeps the mask when the job fails", async () => {
    h.erase.mockResolvedValue({ id: "j1" });
    const user = await loaded();
    paint();
    await user.click(screen.getByRole("button", { name: /^Erase/ }));
    act(() => useJobs.setState({ byId: { j1: job({ status: JobStatus.JobFailed, error: "Model download failed", errorHint: "Check your connection" }) } }));
    expect(await screen.findByText("Model download failed")).toBeTruthy();
    expect(screen.getByText("Check your connection")).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Erase/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a submit error from the service", async () => {
    h.erase.mockRejectedValue({ code: "validation", message: "Paint over what to erase first" });
    const user = await loaded();
    paint();
    await user.click(screen.getByRole("button", { name: /^Erase/ }));
    expect(await screen.findByText("Paint over what to erase first")).toBeTruthy();
  });

  it("compares before/after, toasts the warning, and keeps erasing on the result", async () => {
    h.erase.mockResolvedValue({ id: "j1" });
    const user = await loaded();
    paint();
    await user.click(screen.getByRole("button", { name: /^Erase/ }));
    const out = { id: "o1", path: "/photo (erased).jpg", name: "photo (erased).jpg", sizeBytes: 2048 };
    act(() => useJobs.setState({ byId: { j1: job({ status: JobStatus.JobDone, progress: 1, resultJson: JSON.stringify({ regions: 1, warning: "Large areas may look smeared" }), outputs: [out] as never }) } }));
    expect(await screen.findByLabelText("Before and after")).toBeTruthy();
    expect(useToastStore.getState().toasts.some((t) => t.title === "Large areas may look smeared")).toBe(true);
    await user.click(screen.getByRole("radio", { name: "Result" }));
    expect(await screen.findByAltText("Erased result")).toBeTruthy();

    h.urlFor.mockClear();
    await user.click(screen.getByRole("button", { name: "Keep erasing on the result" }));
    await waitFor(() => expect(h.urlFor).toHaveBeenCalledWith("/photo (erased).jpg"));
    expect(await screen.findByAltText("Photo to edit")).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Erase/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains that HEIC photos can't be painted on", async () => {
    await load("/photo.heic");
    expect(await screen.findByText(/can't be shown for painting/)).toBeTruthy();
    expect(h.urlFor).not.toHaveBeenCalled();
  });

  it("shows TIFF photos through a Go-decoded preview", async () => {
    await load("/scan.tiff");
    const img = (await screen.findByAltText("Photo to edit")) as HTMLImageElement;
    expect(img.src).toContain("data:image/jpeg");
    expect(h.thumb).toHaveBeenCalledWith("/scan.tiff", 1600);
    expect(h.urlFor).not.toHaveBeenCalled();
  });

  it("registers palette entries", () => {
    const ids = eraserCommands().map((c) => c.id);
    expect(ids).toEqual(["eraser.choose-file", "eraser.erase", "eraser.undo", "eraser.redo", "eraser.clear"]);
  });
});
