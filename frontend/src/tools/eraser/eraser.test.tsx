import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pickLib: vi.fn(async (_o: unknown) => [] as string[]),
  erase: vi.fn(),
  saveMask: vi.fn(),
  deleteMask: vi.fn(async (_id: string) => undefined),
  masks: [] as unknown[],
  cancel: vi.fn(async (_id: string) => undefined),
  urlFor: vi.fn(async (p: string) => `/media/t/${p.split("/").pop()}`),
  thumb: vi.fn(async (_p: string, _max: number) => "data:image/jpeg;base64,AAAA"),
  pick: { paths: ["/photo.jpg"] as string[] },
  setState: vi.fn(async (..._a: unknown[]) => undefined),
  maskImage: vi.fn(async (_id: string) => "data:image/png;base64,QUJD"),
}));

vi.mock("@/blocks/library-picker", async (orig) => {
  const actual = await orig<typeof import("@/blocks/library-picker")>();
  return { ...actual, pickFromLibrary: (o: unknown) => h.pickLib(o) };
});

vi.mock("./stamp", async (orig) => {
  const actual = await orig<typeof import("./stamp")>();
  return { ...actual, loadMaskStamp: async () => document.createElement("canvas") };
});

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
      SavedMasks: async () => h.masks,
      SaveMask: (...a: unknown[]) => h.saveMask(...a),
      DeleteMask: (id: string) => h.deleteMask(id),
      SavedMaskImage: (id: string) => h.maskImage(id),
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
import { JobStatus, OutputKind } from "@/lib/api";
import { useJobs, type JobView } from "@/state/jobs";
import { useLibrary } from "@/state/library";
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
    h.saveMask.mockReset();
    h.deleteMask.mockClear();
    h.masks = [];
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
    // The model is a click-in whose summary carries the state; the details are inside.
    const row = await screen.findByRole("button", { name: /^Model/ });
    expect(row.textContent).toContain("Best · downloads 208 MB");
    await userEvent.setup().click(row);
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
    expect(screen.queryByRole("radio", { name: "Fast" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: /^Model/ }));
    await user.click(screen.getByRole("radio", { name: "Fast" }));
    expect(screen.getByRole("button", { name: /^Model/ }).textContent).toContain("Fast · ready");
    paint();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(h.erase).toHaveBeenCalledTimes(1));
    expect(h.erase).toHaveBeenCalledWith("/photo.jpg", "data:image/png;base64,QUJD", { model: "fast", maskPath: "", note: "" });
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

  it("shows HEIC photos through a Go-decoded preview", async () => {
    await load("/photo.heic");
    expect(await screen.findByAltText("Photo to edit")).toBeTruthy();
    expect(h.thumb).toHaveBeenCalledWith("/photo.heic", 1600);
    expect(h.urlFor).not.toHaveBeenCalled();
  });

  it("shows TIFF photos through a Go-decoded preview", async () => {
    await load("/scan.tiff");
    const img = (await screen.findByAltText("Photo to edit")) as HTMLImageElement;
    expect(img.src).toContain("data:image/jpeg");
    expect(h.thumb).toHaveBeenCalledWith("/scan.tiff", 1600);
    expect(h.urlFor).not.toHaveBeenCalled();
  });

  it("saves the painted mask under a name", async () => {
    h.saveMask.mockResolvedValue({ id: "m1", name: "photo mask", width: 2000, height: 1000, createdAt: 1 });
    const user = await loaded();
    await user.click(await screen.findByRole("button", { name: /^Saved masks/ }));
    const save = screen.getByRole("button", { name: "Save mask…" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true); // nothing painted yet
    await user.click(screen.getByRole("button", { name: "Close" }));
    paint();
    await user.click(screen.getByRole("button", { name: /^Saved masks/ }));
    await user.click(screen.getByRole("button", { name: "Save mask…" }));
    const field = screen.getByLabelText("Mask name") as HTMLInputElement;
    expect(field.value).toBe("photo mask");
    await user.clear(field);
    await user.type(field, "Corner logo");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(h.saveMask).toHaveBeenCalledWith("Corner logo", "data:image/png;base64,QUJD"));
    expect(await screen.findByRole("list", { name: "Saved masks" })).toBeTruthy();
    expect(screen.getByText("2000×1000")).toBeTruthy();
  });

  it("lists saved masks and deletes one", async () => {
    h.masks = [{ id: "m1", name: "Watermark", width: 800, height: 600, createdAt: 1 }];
    const user = await loaded();
    const row = await screen.findByRole("button", { name: /^Saved masks/ });
    await waitFor(() => expect(row.textContent).toContain("1 saved"));
    await user.click(row);
    await user.click(screen.getByRole("button", { name: "Delete Watermark" }));
    await waitFor(() => expect(h.deleteMask).toHaveBeenCalledWith("m1"));
    expect(await screen.findByText("No saved masks yet.")).toBeTruthy();
  });

  it("loads a saved mask as an undoable starting mask", async () => {
    h.masks = [{ id: "m1", name: "Watermark", width: 800, height: 600, createdAt: 1 }];
    const user = await loaded();
    const erase = screen.getByRole("button", { name: /^Erase/ }) as HTMLButtonElement;
    expect(erase.disabled).toBe(true);
    await user.click(await screen.findByRole("button", { name: /^Saved masks/ }));
    await user.click(await screen.findByRole("button", { name: "Load Watermark" }));
    await waitFor(() => expect(h.maskImage).toHaveBeenCalledWith("m1"));
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect((screen.getByRole("button", { name: /^Erase/ }) as HTMLButtonElement).disabled).toBe(false));
    const undo = screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    await user.click(undo);
    await waitFor(() => expect((screen.getByRole("button", { name: /^Erase/ }) as HTMLButtonElement).disabled).toBe(true));
  });

  it("lists past results in the empty state and opens one as the photo", async () => {
    useLibrary.setState({
      items: [
        { id: "o1", jobId: "j", moduleId: "object-eraser", path: "/out/erased.png", name: "erased.png", kind: OutputKind.KindImage, sizeBytes: 10, createdAt: Date.now(), tags: [], missing: false },
        { id: "o2", jobId: "j", moduleId: "converter", path: "/out/other.png", name: "other.png", kind: OutputKind.KindImage, sizeBytes: 10, createdAt: Date.now(), tags: [], missing: false },
      ],
    });
    render(<ObjectEraserView moduleId="object-eraser" />);
    expect(screen.getByText("erased.png")).toBeTruthy();
    expect(screen.queryByText("other.png")).toBeNull();
    fireEvent.doubleClick(screen.getByRole("group", { name: "erased.png" }));
    expect(await screen.findByAltText("Photo to edit")).toBeTruthy();
    useLibrary.setState({ items: [] });
  });

  it("opens a photo chosen from the Library like a native pick", async () => {
    h.pickLib.mockResolvedValueOnce(["/lib/made.png"]);
    const user = userEvent.setup();
    render(<ObjectEraserView moduleId="object-eraser" />);
    await user.click(screen.getByRole("button", { name: "From Library…" }));
    expect(h.pickLib).toHaveBeenCalledTimes(1);
    expect(await screen.findByAltText("Photo to edit")).toBeTruthy();
  });

  it("registers palette entries", () => {
    const ids = eraserCommands().map((c) => c.id);
    expect(ids).toEqual(["eraser.choose-file", "eraser.choose-library", "eraser.erase", "eraser.undo", "eraser.redo", "eraser.clear"]);
  });
});
