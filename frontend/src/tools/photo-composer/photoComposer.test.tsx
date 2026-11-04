import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  save: vi.fn(),
  duplicate: vi.fn(),
  del: vi.fn(),
  removeBg: vi.fn(),
  exportFn: vi.fn(),
  postsGet: vi.fn(),
  postsList: vi.fn(),
  postsSave: vi.fn(),
  exportComposition: vi.fn(),
  applyLayout: vi.fn(),
  sources: vi.fn(),
  closeWindow: vi.fn(async (_k: string) => undefined),
  drop: { current: null as null | ((info: { paths: string[]; x: number; y: number }) => void) },
}));

vi.mock("@/blocks/sources/sourceDrag", async (orig) => {
  const actual = await orig<typeof import("@/blocks/sources/sourceDrag")>();
  return {
    ...actual,
    useSourceDropTarget: (_ref: unknown, onDrop: (info: { paths: string[]; x: number; y: number }) => void) => {
      m.drop.current = onDrop;
    },
  };
});

vi.mock("@/blocks/sources/SourceGrid", () => ({
  SourceGrid: (p: { sources: Array<{ path: string; name: string }>; onActivate?: (path: string) => void; emptyLabel?: string }) => (
    <ul aria-label="Sources">
      {p.sources.length === 0 && <li>{p.emptyLabel}</li>}
      {p.sources.map((s) => (
        <li key={s.path}>
          <button onDoubleClick={() => p.onActivate?.(s.path)} onKeyDown={(e) => e.key === "Enter" && p.onActivate?.(s.path)}>
            {s.name}
          </button>
        </li>
      ))}
    </ul>
  ),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    ComposerService: {
      List: (...a: unknown[]) => m.list(...a),
      Get: (...a: unknown[]) => m.get(...a),
      Create: (...a: unknown[]) => m.create(...a),
      Save: (...a: unknown[]) => m.save(...a),
      Duplicate: (...a: unknown[]) => m.duplicate(...a),
      Delete: (...a: unknown[]) => m.del(...a),
      RemoveBackground: (...a: unknown[]) => m.removeBg(...a),
      Export: (...a: unknown[]) => m.exportFn(...a),
      Aspects: async () => null,
    },
    PostsService: {
      Get: (...a: unknown[]) => m.postsGet(...a),
      List: (...a: unknown[]) => m.postsList(...a),
      Save: (...a: unknown[]) => m.postsSave(...a),
      Sources: (...a: unknown[]) => m.sources(...a),
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    FilesService: { PickWith: async () => [], ImageThumb: async () => "data:image/png;base64,AAAA" },
    LibraryService: { Reveal: async () => undefined },
    DesktopService: { CloseWindow: (k: string) => m.closeWindow(k), OpenWindows: async () => [] },
  };
});

vi.mock("@/composer/loadImages", () => {
  const bmp = { width: 400, height: 300, close() {} } as unknown as ImageBitmap;
  return {
    EDIT_DIM: 2048,
    loadImage: async () => bmp,
    loadImages: async (paths: string[]) => ({ images: new Map(paths.map((p) => [p, bmp])), failed: new Map() }),
  };
});

vi.mock("@/composer/render", async (orig) => {
  const actual = await orig<typeof import("@/composer/render")>();
  return { ...actual, renderComposition: () => undefined };
});

vi.mock("@/composer/export", () => ({ exportComposition: (...a: unknown[]) => m.exportComposition(...a) }));

vi.mock("@/composer/layouts", async (orig) => {
  const actual = await orig<typeof import("@/composer/layouts")>();
  m.applyLayout.mockImplementation(actual.applyLayout);
  return { ...actual, applyLayout: (...a: Parameters<typeof actual.applyLayout>) => m.applyLayout(...a) };
});

import { JobStatus, type Composition, type Job, type ProjectInfo } from "@/lib/api";
import { addLayer, newComposition, newImageLayer, newTextLayer } from "@/composer/model";
import { useJobs } from "@/state/jobs";
import { useUI } from "@/state/ui";
import PhotoComposerView from "./PhotoComposerView";
import { discardedProjects } from "./useAutosave";
import { displayToDocIndex, dropIndex, fitScale, moveWithSnap, nudge, panBackground, scaleByHandle } from "./logic";
import { layerBox } from "@/composer/hittest";

const info = (id: string, name = id, items = 0): ProjectInfo =>
  ({ id, kind: "composition", name, thumb: "", items, missing: 0, updatedAt: 1 }) as unknown as ProjectInfo;

let projects: ProjectInfo[];
let docs: Record<string, Composition>;

function twoPhotos(): Composition {
  const d0 = newComposition("4:5");
  const a = { ...newImageLayer("C:/photos/a.jpg", 400, 300, d0), id: "A", name: "a" };
  const b = { ...newImageLayer("C:/photos/b.jpg", 400, 300, d0), id: "B", name: "b" };
  return addLayer(addLayer(d0, a), b);
}

function renderView() {
  return render(<PhotoComposerView moduleId="photo-composer" />);
}

const layerList = () => screen.getByRole("list", { name: "Layers" });
const layerNames = () => within(layerList()).getAllByRole("listitem").map((li) => li.querySelector("span[title]")?.textContent ?? "");

/** Opens a click-in drawer by its launcher (one drawer is open at a time). */
async function showPanel(name: string) {
  const launcher = screen.getByRole("button", { name: new RegExp(`^${name}`) });
  if (launcher.getAttribute("aria-expanded") !== "true") await userEvent.click(launcher);
  await screen.findByRole("dialog", { name });
}

async function openProject(name: string) {
  await userEvent.click(await screen.findByRole("button", { name: `Open ${name}` }));
  await screen.findByRole("toolbar", { name: "Composer tools" });
}

beforeEach(() => {
  projects = [info("p1", "Market", 2)];
  docs = { p1: twoPhotos() };
  m.list.mockReset().mockImplementation(async () => projects);
  m.get.mockReset().mockImplementation(async (id: string) => docs[id]);
  m.create.mockReset().mockImplementation(async (name: string, aspect: string) => {
    const created = info("new1", name);
    projects = [created, ...projects];
    docs.new1 = newComposition(aspect);
    return created;
  });
  m.save.mockReset().mockImplementation(async (id: string, name: string) => info(id, name));
  m.duplicate.mockReset().mockResolvedValue(info("p2", "Market copy"));
  m.del.mockReset().mockResolvedValue(undefined);
  m.removeBg.mockReset();
  m.exportFn.mockReset();
  m.exportComposition.mockReset().mockResolvedValue({});
  m.postsGet.mockReset().mockResolvedValue({ version: 1, format: "carousel", aspect: "4:5", slides: [{ id: "s1", kind: "photo", path: "", projectId: "" }], caption: "" });
  m.postsList.mockReset().mockResolvedValue([{ id: "post1", name: "My post" }]);
  m.postsSave.mockReset().mockResolvedValue({});
  m.applyLayout.mockClear();
  m.sources.mockReset().mockResolvedValue([]);
  m.drop.current = null;
  useJobs.setState({ byId: {} });
  useUI.setState({ handoff: null, view: "photo-composer" });
  discardedProjects.clear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("projects strip", () => {
  it("lists compositions and opens one", async () => {
    renderView();
    await openProject("Market");
    expect(screen.queryByRole("button", { name: "Open Market" })).toBeNull(); // the strip is only on the home
    await showPanel("Layers");
    expect(layerNames()).toEqual(["b", "a"]);
  });

  it("shows summaries on the click-in launchers", async () => {
    renderView();
    await openProject("Market");
    const launcher = (n: string) => screen.getByRole("button", { name: new RegExp(`^${n}`) }).textContent ?? "";
    expect(launcher("Layers")).toContain("2 layers");
    expect(launcher("Properties")).toContain("Nothing selected");
    expect(launcher("Background")).toContain("Colour");
    expect(screen.queryByRole("button", { name: /^Sources/ })).toBeNull();
  });

  it("creates a new composition from the New dialog", async () => {
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: /new composition/i }));
    const dialog = await screen.findByRole("dialog", { name: "New composition" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Shape"), "9:16");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await screen.findByRole("toolbar", { name: "Composer tools" });
    expect(m.create).toHaveBeenCalledWith("Untitled composition", "9:16", "");
  });

  it("duplicates and deletes from the actions menu", async () => {
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "More actions for Market" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Duplicate/ }));
    await waitFor(() => expect(m.duplicate).toHaveBeenCalledWith("p1"));

    await userEvent.click(screen.getByRole("button", { name: "More actions for Market" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }));
    const confirm = await screen.findByRole("dialog");
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(m.del).toHaveBeenCalledWith("p1"));
  });
});

describe("editor", () => {
  it("adds photos handed over from the Library as layers", async () => {
    docs.new1 = newComposition("4:5");
    renderView();
    await act(async () => {
      useUI.getState().handOff({ moduleId: "photo-composer", inputs: ["C:/x/one.jpg", "C:/x/two.png"] });
    });
    await screen.findByRole("toolbar", { name: "Composer tools" });
    await showPanel("Layers");
    await waitFor(() => expect(layerNames()).toEqual(["two", "one"]));
    expect(useUI.getState().handoff).toBeNull();
  });

  it("selects, nudges and deletes a layer from the keyboard", async () => {
    renderView();
    await openProject("Market");
    await showPanel("Layers");
    const rowB = within(layerList()).getAllByRole("listitem")[0] as HTMLElement;
    fireEvent.pointerDown(rowB, { button: 0, clientY: 10 });
    fireEvent.pointerUp(rowB);
    await showPanel("Properties");
    const tool = screen.getByRole("toolbar");
    const x = screen.getByLabelText("X") as HTMLInputElement;
    expect(x.value).toBe("540");
    fireEvent.keyDown(tool, { key: "ArrowRight" });
    await waitFor(() => expect((screen.getByLabelText("X") as HTMLInputElement).value).toBe("541"));
    fireEvent.keyDown(tool, { key: "ArrowDown", shiftKey: true });
    await waitFor(() => expect((screen.getByLabelText("Y") as HTMLInputElement).value).toBe("685"));
    fireEvent.keyDown(tool, { key: "Delete" });
    await showPanel("Layers");
    await waitFor(() => expect(layerNames()).toEqual(["a"]));
  });

  it("undoes with Ctrl+Z", async () => {
    renderView();
    await openProject("Market");
    await showPanel("Layers");
    const rowB = within(layerList()).getAllByRole("listitem")[0] as HTMLElement;
    fireEvent.pointerDown(rowB, { button: 0 });
    fireEvent.pointerUp(rowB);
    fireEvent.keyDown(rowB, { key: "Delete" });
    await waitFor(() => expect(layerNames()).toEqual(["a"]));
    fireEvent.keyDown(screen.getByRole("toolbar"), { key: "z", ctrlKey: true });
    await waitFor(() => expect(layerNames()).toEqual(["b", "a"]));
  });

  it("reorders layers with the arrange buttons", async () => {
    renderView();
    await openProject("Market");
    await showPanel("Layers");
    const rowB = within(layerList()).getAllByRole("listitem")[0] as HTMLElement;
    fireEvent.pointerDown(rowB, { button: 0 });
    fireEvent.pointerUp(rowB);
    await showPanel("Properties");
    await userEvent.click(screen.getByRole("button", { name: "Backward" }));
    await showPanel("Layers");
    expect(layerNames()).toEqual(["a", "b"]);
    await showPanel("Properties");
    await userEvent.click(screen.getByRole("button", { name: "Front" }));
    await showPanel("Layers");
    expect(layerNames()).toEqual(["b", "a"]);
  });

  it("reorders layers by dragging a row", async () => {
    renderView();
    await openProject("Market");
    await showPanel("Layers");
    const rows = within(layerList()).getAllByRole("listitem") as HTMLElement[];
    rows.forEach((r, i) => {
      r.getBoundingClientRect = () => ({ top: i * 40, height: 40, bottom: i * 40 + 40, left: 0, right: 100, width: 100, x: 0, y: i * 40, toJSON() {} });
    });
    // Drag the top row (b) below the second (a): pointer ends at y = 70.
    fireEvent.pointerDown(rows[0] as HTMLElement, { button: 0, clientY: 20 });
    fireEvent.pointerMove(rows[0] as HTMLElement, { clientY: 70 });
    fireEvent.pointerUp(rows[0] as HTMLElement, { clientY: 70 });
    await waitFor(() => expect(layerNames()).toEqual(["a", "b"]));
  });

  it("hides, locks and renames a layer", async () => {
    renderView();
    await openProject("Market");
    await showPanel("Layers");
    const rowB = within(layerList()).getAllByRole("listitem")[0] as HTMLElement;
    await userEvent.click(within(rowB).getByRole("button", { name: "Hide layer" }));
    expect(within(rowB).getByRole("button", { name: "Show layer" })).toBeTruthy();
    await userEvent.click(within(rowB).getByRole("button", { name: "Lock layer" }));
    expect(within(rowB).getByRole("button", { name: "Unlock layer" })).toBeTruthy();
    await userEvent.dblClick(within(rowB).getByText("b"));
    const field = within(rowB).getByLabelText("Layer name");
    await userEvent.clear(field);
    await userEvent.type(field, "hero{Enter}");
    await waitFor(() => expect(layerNames()[0]).toBe("hero"));
  });

  it("edits properties of the selected layer", async () => {
    renderView();
    await openProject("Market");
    await showPanel("Layers");
    const rowB = within(layerList()).getAllByRole("listitem")[0] as HTMLElement;
    fireEvent.pointerDown(rowB, { button: 0 });
    fireEvent.pointerUp(rowB);
    await showPanel("Properties");
    fireEvent.change(screen.getByLabelText("Rotation"), { target: { value: "30" } });
    await userEvent.click(screen.getByRole("switch", { name: "Shadow" }));
    await userEvent.click(screen.getByRole("switch", { name: "Mirror" }));
    await waitFor(() => expect(m.save).toHaveBeenCalled());
    const saved = m.save.mock.calls.at(-1)?.[2] as Composition;
    const b = saved.layers?.find((l) => l.id === "B");
    expect(b?.rotation).toBe(30);
    expect(b?.shadow.on).toBe(true);
    expect(b?.flipX).toBe(true);
  });

  it("applies a layout from the menu", async () => {
    renderView();
    await openProject("Market");
    await userEvent.click(screen.getByRole("button", { name: "Layouts" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /^Grid/ }));
    expect(m.applyLayout).toHaveBeenCalled();
    expect(m.applyLayout.mock.calls[0]?.[1]).toBe("grid");
  });

  it("adds a text layer and opens it for editing", async () => {
    renderView();
    await openProject("Market");
    await userEvent.click(screen.getByRole("button", { name: "Add text" }));
    expect(screen.getByLabelText("Edit text")).toBeTruthy();
    await showPanel("Layers");
    expect(layerNames()[0]).toBe("Text");
  });
});

describe("remove background", () => {
  const job = (status: string, outputs: Array<{ path: string }> = [], extra: Partial<Job> = {}): Job =>
    ({ id: "job1", moduleId: "bg-remover", title: "", status, progress: 0, message: "", inputs: [], outputs, error: "", errorHint: "", ...extra }) as unknown as Job;

  async function selectB() {
    renderView();
    await openProject("Market");
    await showPanel("Layers");
    const rowB = within(layerList()).getAllByRole("listitem")[0] as HTMLElement;
    fireEvent.pointerDown(rowB, { button: 0 });
    fireEvent.pointerUp(rowB);
  }

  it("swaps in the cut-out when the job is done and restores the original", async () => {
    m.removeBg.mockResolvedValue(job(JobStatus.JobRunning));
    await selectB();
    await userEvent.click(screen.getAllByRole("button", { name: "Remove background" })[0] as HTMLElement);
    expect(m.removeBg).toHaveBeenCalledWith("C:/photos/b.jpg");
    await showPanel("Layers");
    expect(screen.getAllByRole("status", { name: "Removing background" }).length).toBeGreaterThan(0);

    act(() => useJobs.getState().upsert(job(JobStatus.JobDone, [{ path: "C:/out/b-cut.png" }])));
    await showPanel("Properties");
    const restore = await screen.findByRole("button", { name: "Restore original" });
    await waitFor(() => expect(m.save).toHaveBeenCalledTimes(1));
    let saved = m.save.mock.calls.at(-1)?.[2] as Composition;
    expect(saved.layers?.find((l) => l.id === "B")?.image?.ref).toEqual({ path: "C:/out/b-cut.png", original: "C:/photos/b.jpg" });
    expect(screen.queryByRole("status", { name: "Removing background" })).toBeNull();

    fireEvent.click(restore);
    await waitFor(() => expect(m.save).toHaveBeenCalledTimes(2));
    saved = m.save.mock.calls.at(-1)?.[2] as Composition;
    expect(saved.layers?.find((l) => l.id === "B")?.image?.ref.path).toBe("C:/photos/b.jpg");
    expect(screen.queryByRole("button", { name: "Restore original" })).toBeNull();
  });

  it("reports a failed job with its hint", async () => {
    m.removeBg.mockResolvedValue(job(JobStatus.JobRunning));
    await selectB();
    await userEvent.click(screen.getAllByRole("button", { name: "Remove background" })[0] as HTMLElement);
    act(() => useJobs.getState().upsert(job(JobStatus.JobFailed, [], { error: "Engine missing", errorHint: "Install the Image pack." })));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Removing background" })).toBeNull());
    const { useToastStore } = await import("@/components/toast");
    expect(useToastStore.getState().toasts.some((t) => t.description?.includes("Install the Image pack."))).toBe(true);
  });
});

describe("autosave", () => {
  it("saves 800 ms after the last change, then renders and saves the picture", async () => {
    renderView();
    await openProject("Market");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add text" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(m.save).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(m.save).toHaveBeenCalledTimes(1);
    expect(m.save.mock.calls[0]?.[0]).toBe("p1");
    expect((m.save.mock.calls[0]?.[2] as Composition).layers).toHaveLength(3);
    expect(m.exportComposition).toHaveBeenCalledTimes(1);
    expect(m.exportComposition.mock.calls[0]?.[0]).toBe("p1");
    expect(m.exportComposition.mock.calls[0]?.[2]).toBe(1);
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("shows when saving failed", async () => {
    m.save.mockRejectedValue(new Error("disk full"));
    renderView();
    await openProject("Market");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add text" }));
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(screen.getByText("Couldn't save")).toBeTruthy();
  });

  it("saves pending changes when leaving the view", async () => {
    const { unmount } = renderView();
    await openProject("Market");
    await userEvent.click(screen.getByRole("button", { name: "Add text" }));
    expect(m.save).not.toHaveBeenCalled();
    unmount();
    await waitFor(() => expect(m.save).toHaveBeenCalledTimes(1));
  });
});

describe("post handoff", () => {
  const slide = { postId: "post1", slideId: "s1", aspect: "9:16", projectId: "" };

  it("creates a composition at the post's aspect and links it on the first save", async () => {
    renderView();
    await act(async () => {
      useUI.getState().handOff({ moduleId: "photo-composer", inputs: [], postSlide: slide });
    });
    await screen.findByRole("toolbar", { name: "Composer tools" });
    expect(m.create).toHaveBeenCalledWith("Untitled composition", "9:16", "");
    expect(m.postsSave).not.toHaveBeenCalled();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add text" }));
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(m.save).toHaveBeenCalled();
    await waitFor(() => expect(m.postsSave).toHaveBeenCalledTimes(1));
    const [postId, name, post] = m.postsSave.mock.calls[0] as [string, string, { slides: Array<{ id: string; kind: string; projectId: string }> }];
    expect(postId).toBe("post1");
    expect(name).toBe("My post");
    expect(post.slides[0]).toMatchObject({ id: "s1", kind: "composition", projectId: "new1" });

    // Later saves do not link again.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add text" }));
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(m.postsSave).toHaveBeenCalledTimes(1);
  });

  it("opens the linked composition and goes back to the post", async () => {
    renderView();
    await act(async () => {
      useUI.getState().handOff({ moduleId: "photo-composer", inputs: [], postSlide: { ...slide, projectId: "p1" } });
    });
    await screen.findByRole("toolbar", { name: "Composer tools" });
    expect(m.create).not.toHaveBeenCalled();
    await showPanel("Layers");
    expect(layerNames()).toEqual(["b", "a"]);
    await userEvent.click(screen.getByRole("button", { name: "Back to post" }));
    await waitFor(() => expect(useUI.getState().handoff?.moduleId).toBe("post-builder"));
    expect(useUI.getState().handoff?.postSlide).toEqual({ ...slide, projectId: "p1" });
    expect(m.postsSave).not.toHaveBeenCalled();
  });

  it("in its own window, Back to post links, saves and closes the window instead of handing off", async () => {
    const { setCurrentWindowForTest, parseWindow } = await import("@/lib/windows");
    setCurrentWindowForTest(parseWindow("?window=tool&view=photo-composer&key=tool:photo-composer"));
    try {
      renderView();
      await act(async () => {
        useUI.getState().handOff({ moduleId: "photo-composer", inputs: [], postSlide: slide });
      });
      await screen.findByRole("toolbar", { name: "Composer tools" });
      await userEvent.click(screen.getByRole("button", { name: "Back to post" }));
      await waitFor(() => expect(m.closeWindow).toHaveBeenCalledWith("tool:photo-composer"));
      expect(m.postsSave).toHaveBeenCalledTimes(1);
      expect(useUI.getState().handoff).toBeNull();
    } finally {
      setCurrentWindowForTest(null);
    }
  });

  it("links an untouched new composition when going back to the post", async () => {
    renderView();
    await act(async () => {
      useUI.getState().handOff({ moduleId: "photo-composer", inputs: [], postSlide: slide });
    });
    await screen.findByRole("toolbar", { name: "Composer tools" });
    await userEvent.click(screen.getByRole("button", { name: "Back to post" }));
    await waitFor(() => expect(useUI.getState().handoff?.moduleId).toBe("post-builder"));
    expect(m.save).toHaveBeenCalled();
    expect(m.postsSave).toHaveBeenCalledTimes(1);
    expect(useUI.getState().handoff?.postSlide?.projectId).toBe("new1");
  });
});

const cutJob = (path: string, status: string, outputs: Array<{ path: string }> = [], extra: Partial<Job> = {}): Job =>
  ({ id: `job:${path}`, moduleId: "bg-remover", title: "", status, progress: 0, message: "", inputs: [path], outputs, error: "", errorHint: "", ...extra }) as unknown as Job;

describe("collage build", () => {
  const SRC = ["C:/s/bg.jpg", "C:/s/1.jpg", "C:/s/2.jpg", "C:/s/3.jpg"];
  const slide = {
    postId: "post1",
    slideId: "s1",
    aspect: "4:5",
    projectId: "",
    build: { kind: "collage" as const, background: "C:/s/bg.jpg", color: "", cutouts: true, layout: "grid" as const },
  };

  async function startBuild(over: Partial<typeof slide.build> = {}, inputs = SRC) {
    m.removeBg.mockImplementation(async (path: string) => cutJob(path, JobStatus.JobRunning));
    renderView();
    await act(async () => {
      useUI.getState().handOff({ moduleId: "photo-composer", inputs, postSlide: { ...slide, build: { ...slide.build, ...over } } });
    });
    await screen.findByRole("toolbar", { name: "Composer tools" });
  }
  const finish = (n: number) => act(() => useJobs.getState().upsert(cutJob(`C:/s/${n}.jpg`, JobStatus.JobDone, [{ path: `C:/out/${n}-cut.png` }])));
  const lastSaved = () => m.save.mock.calls.at(-1)?.[2] as Composition;

  it("adds every other source as a layer, cuts them out one job each, and lays out twice", async () => {
    await startBuild();
    await showPanel("Layers");
    await waitFor(() => expect(layerNames()).toEqual(["3", "2", "1"]));
    await waitFor(() => expect(m.removeBg.mock.calls.map((c) => c[0])).toEqual(["C:/s/1.jpg", "C:/s/2.jpg", "C:/s/3.jpg"]));
    // Shimmer on the stage and a spinner per layer while they are being cut out.
    expect(screen.getAllByTestId("cutting-shimmer")).toHaveLength(3);
    expect(m.applyLayout).toHaveBeenCalledTimes(1);
    expect(m.applyLayout.mock.calls[0]?.[1]).toBe("grid");

    await finish(1);
    await finish(2);
    expect(m.applyLayout).toHaveBeenCalledTimes(1);
    await finish(3);
    await waitFor(() => expect(m.applyLayout).toHaveBeenCalledTimes(2));
    expect(screen.queryAllByTestId("cutting-shimmer")).toHaveLength(0);

    await waitFor(() => expect(lastSaved().layers?.map((l) => l.image?.ref.path)).toEqual(["C:/out/1-cut.png", "C:/out/2-cut.png", "C:/out/3-cut.png"]), { timeout: 3000 });
    expect(lastSaved().layers?.map((l) => l.image?.ref.original)).toEqual(["C:/s/1.jpg", "C:/s/2.jpg", "C:/s/3.jpg"]);
    expect(lastSaved().background.image?.path).toBe("C:/s/bg.jpg");
    expect(lastSaved().background.kind).toBe("image");
  });

  it("uses a colour background and skips cut-outs when asked", async () => {
    await startBuild({ background: "", color: "#112233", cutouts: false });
    await showPanel("Layers");
    await waitFor(() => expect(layerNames()).toHaveLength(4));
    await waitFor(() => expect(m.applyLayout).toHaveBeenCalledTimes(1));
    expect(m.removeBg).not.toHaveBeenCalled();
    await waitFor(() => expect(m.save).toHaveBeenCalled(), { timeout: 3000 });
    expect(lastSaved().background).toMatchObject({ kind: "color", color: "#112233" });
  });

  it("does not rearrange after the user moved a layer", async () => {
    await startBuild();
    await waitFor(() => expect(m.removeBg).toHaveBeenCalledTimes(3));
    await showPanel("Layers");
    const row = within(layerList()).getAllByRole("listitem")[0] as HTMLElement;
    fireEvent.pointerDown(row, { button: 0, clientY: 10 });
    fireEvent.pointerUp(row);
    fireEvent.keyDown(row, { key: "ArrowRight" });
    await finish(1);
    await finish(2);
    await finish(3);
    await waitFor(() => expect(lastSaved()).toBeDefined(), { timeout: 3000 });
    await waitFor(() => expect(screen.queryAllByTestId("cutting-shimmer")).toHaveLength(0));
    expect(m.applyLayout).toHaveBeenCalledTimes(1);
  });

  it("keeps the original on a failed job and reports it once", async () => {
    await startBuild();
    await waitFor(() => expect(m.removeBg).toHaveBeenCalledTimes(3));
    const { useToastStore } = await import("@/components/toast");
    useToastStore.setState({ toasts: [] });
    const fail = (n: number) =>
      act(() => useJobs.getState().upsert(cutJob(`C:/s/${n}.jpg`, JobStatus.JobFailed, [], { error: "Image pack missing", errorHint: "Install the Image pack." })));
    await fail(1);
    await fail(2);
    await finish(3);
    await waitFor(() => expect(screen.queryAllByTestId("cutting-shimmer")).toHaveLength(0));
    const toasts = useToastStore.getState().toasts.filter((t) => t.description?.includes("Install the Image pack."));
    expect(toasts).toHaveLength(1);
    await waitFor(() => expect(lastSaved().layers?.map((l) => l.image?.ref.path)).toEqual(["C:/s/1.jpg", "C:/s/2.jpg", "C:/out/3-cut.png"]), { timeout: 3000 });
  });

  it("links the new composition to the slide on the first save", async () => {
    await startBuild({ cutouts: false });
    await waitFor(() => expect(m.postsSave).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const post = m.postsSave.mock.calls[0]?.[2] as { slides: Array<{ id: string; kind: string; projectId: string }> };
    expect(post.slides[0]).toMatchObject({ id: "s1", kind: "composition", projectId: "new1" });
    expect(m.create).toHaveBeenCalledWith("Untitled composition", "4:5", "C:/s/bg.jpg");
  });
});

describe("batch remove background", () => {
  const ctrlClick = (row: HTMLElement) => {
    fireEvent.pointerDown(row, { button: 0, ctrlKey: true });
    fireEvent.pointerUp(row);
  };

  it("cuts out every selected layer, one job each, and restores them together", async () => {
    m.removeBg.mockImplementation(async (path: string) => cutJob(path, JobStatus.JobRunning));
    renderView();
    await openProject("Market");
    await showPanel("Layers");
    const rows = within(layerList()).getAllByRole("listitem") as HTMLElement[];
    fireEvent.pointerDown(rows[0] as HTMLElement, { button: 0 });
    fireEvent.pointerUp(rows[0] as HTMLElement);
    ctrlClick(rows[1] as HTMLElement);
    await showPanel("Properties");
    expect(screen.getByText("2 layers selected")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Properties/ }).textContent).toContain("2 selected");

    await userEvent.click(screen.getByRole("button", { name: "Remove background (2)" }));
    await waitFor(() => expect(m.removeBg.mock.calls.map((c) => c[0])).toEqual(["C:/photos/b.jpg", "C:/photos/a.jpg"]));
    await showPanel("Layers");
    expect(screen.getAllByRole("status", { name: "Removing background" }).length).toBeGreaterThanOrEqual(2);

    act(() => {
      useJobs.getState().upsert(cutJob("C:/photos/b.jpg", JobStatus.JobDone, [{ path: "C:/out/b.png" }]));
      useJobs.getState().upsert(cutJob("C:/photos/a.jpg", JobStatus.JobDone, [{ path: "C:/out/a.png" }]));
    });
    await waitFor(() => expect(m.save).toHaveBeenCalledTimes(1));
    expect(lastSavedLayers().map((l) => l.image?.ref)).toEqual([
      { path: "C:/out/a.png", original: "C:/photos/a.jpg" },
      { path: "C:/out/b.png", original: "C:/photos/b.jpg" },
    ]);

    await showPanel("Properties");
    await userEvent.click(screen.getByRole("button", { name: "Restore originals" }));
    await waitFor(() => expect(m.save).toHaveBeenCalledTimes(2));
    expect(lastSavedLayers().map((l) => l.image?.ref)).toEqual([
      { path: "C:/photos/a.jpg", original: "" },
      { path: "C:/photos/b.jpg", original: "" },
    ]);
  });

  function lastSavedLayers() {
    return ((m.save.mock.calls.at(-1)?.[2] as Composition).layers ?? []) as NonNullable<Composition["layers"]>;
  }
});

describe("sources tab", () => {
  const slide = { postId: "post1", slideId: "s1", aspect: "4:5", projectId: "p1" };
  const sources = [
    { path: "C:/s/x.jpg", name: "x.jpg", kind: "photo" },
    { path: "C:/s/clip.mp4", name: "clip.mp4", kind: "clip" },
  ];

  async function openFromPost() {
    renderView();
    await act(async () => {
      useUI.getState().handOff({ moduleId: "photo-composer", inputs: [], postSlide: slide });
    });
    await screen.findByRole("toolbar", { name: "Composer tools" });
  }

  it("is only there when the composition came from a post", async () => {
    renderView();
    await openProject("Market");
    expect(screen.queryByRole("button", { name: /^Sources/ })).toBeNull();
    expect(m.sources).not.toHaveBeenCalled();
  });

  it("lists the photos and adds one at the centre on activation", async () => {
    m.sources.mockResolvedValue(sources);
    await openFromPost();
    await showPanel("Sources");
    expect(m.sources).toHaveBeenCalledWith("post1");
    expect(await screen.findByText("x.jpg")).toBeTruthy();
    expect(screen.queryByText("clip.mp4")).toBeNull();

    fireEvent.doubleClick(screen.getByText("x.jpg"));
    await showPanel("Layers");
    await waitFor(() => expect(layerNames()).toEqual(["x", "b", "a"]));
    await showPanel("Properties");
    expect((screen.getByLabelText("X") as HTMLInputElement).value).toBe("540");
    expect((screen.getByLabelText("Y") as HTMLInputElement).value).toBe("675");
  });

  it("adds sources dropped on the stage at the drop point", async () => {
    m.sources.mockResolvedValue(sources);
    await openFromPost();
    const stage = screen.getByTestId("composer-stage");
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({ left: 100, top: 100, width: 200, height: 400, right: 300, bottom: 500, x: 100, y: 100, toJSON: () => ({}) });
    await act(async () => {
      m.drop.current?.({ paths: ["C:/s/x.jpg"], x: 150, y: 200 });
    });
    await showPanel("Layers");
    await waitFor(() => expect(layerNames()).toEqual(["x", "b", "a"]));
    await showPanel("Properties");
    expect((screen.getByLabelText("X") as HTMLInputElement).value).toBe("270");
    expect((screen.getByLabelText("Y") as HTMLInputElement).value).toBe("337.5");
  });

  it("explains when the sources can't be listed and refreshes on demand", async () => {
    m.sources.mockRejectedValueOnce(new Error("not implemented")).mockResolvedValue(sources);
    await openFromPost();
    await showPanel("Sources");
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't list");
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("x.jpg")).toBeTruthy();
    expect(m.sources).toHaveBeenCalledTimes(2);
  });
});

describe("stage geometry", () => {
  it("fits the canvas into the available area", () => {
    expect(fitScale(1032, 1432, 1080, 1350, 32)).toBeCloseTo(1000 / 1080, 5);
    expect(fitScale(10, 10, 1080, 1350)).toBe(0.02);
  });

  it("snaps a moved layer to the canvas centre", () => {
    const d = twoPhotos();
    const l = { ...(d.layers?.[0] as NonNullable<Composition["layers"]>[number]), x: 0.4, y: 0.5 };
    const doc = { ...d, layers: [l] };
    const sizer = () => ({ w: 300, h: 200 });
    const box = layerBox(doc, l, sizer);
    const near = moveWithSnap(doc, l, box, 108 - 4, 0, sizer, 6);
    expect(near.patch.x).toBeCloseTo(0.5, 5);
    expect(near.guides.some((g) => g.axis === "x")).toBe(true);
    const far = moveWithSnap(doc, l, box, 40, 0, sizer, 6);
    expect(far.guides.some((g) => g.axis === "x" && Math.abs(g.pos - 540) < 0.1)).toBe(false);
  });

  it("scales uniformly from a corner and clamps the size", () => {
    const d = twoPhotos();
    const l = d.layers?.[0] as NonNullable<Composition["layers"]>[number];
    const box = { cx: 540, cy: 675, w: 200, h: 100, rot: 0 };
    const r = scaleByHandle(d, { ...l, size: 0.2 }, box, "se", { x: 740, y: 725 + 100 }, false);
    expect(r.size).toBeGreaterThan(0.2);
    const tiny = scaleByHandle(d, { ...l, size: 0.2 }, box, "se", { x: 440, y: 625 }, false);
    expect(tiny.size).toBeGreaterThanOrEqual(0.005);
  });

  it("nudges by 1 px, or 10 with Shift", () => {
    const d = newComposition("1:1");
    const t = newTextLayer(d);
    expect(nudge(d, t, "ArrowRight", false)?.x).toBeCloseTo(0.5 + 1 / 1080, 6);
    expect(nudge(d, t, "ArrowUp", true)?.y).toBeCloseTo(0.5 - 10 / 1080, 6);
    expect(nudge(d, t, "a", false)).toBeNull();
  });

  it("works out where a dragged row lands and maps display to document order", () => {
    expect(dropIndex([20, 60, 100], 0, 70)).toBe(1);
    expect(dropIndex([20, 60, 100], 2, 10)).toBe(0);
    expect(displayToDocIndex(3, 0)).toBe(2);
    expect(displayToDocIndex(3, 2)).toBe(0);
  });

  it("pans a background photo opposite to the drag and stays in range", () => {
    const doc = { ...newComposition("1:1") };
    const r = panBackground(doc, { w: 2160, h: 1080 }, { panX: 0, panY: 0 }, -270, 50);
    expect(r.panX).toBeCloseTo(0.5, 5);
    expect(r.panY).toBe(0);
    expect(panBackground(doc, { w: 2160, h: 1080 }, { panX: 0.9, panY: 0 }, -1000, 0).panX).toBe(1);
  });
});
