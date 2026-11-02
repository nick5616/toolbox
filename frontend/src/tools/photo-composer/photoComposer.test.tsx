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
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    FilesService: { PickWith: async () => [], ImageThumb: async () => "data:image/png;base64,AAAA" },
    LibraryService: { Reveal: async () => undefined },
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
    expect(layerNames()).toEqual(["b", "a"]);
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
    await waitFor(() => expect(layerNames()).toEqual(["two", "one"]));
    expect(useUI.getState().handoff).toBeNull();
  });

  it("selects, nudges and deletes a layer from the keyboard", async () => {
    renderView();
    await openProject("Market");
    const rowB = within(layerList()).getAllByRole("listitem")[0] as HTMLElement;
    fireEvent.pointerDown(rowB, { button: 0, clientY: 10 });
    fireEvent.pointerUp(rowB);
    const x = screen.getByLabelText("X") as HTMLInputElement;
    expect(x.value).toBe("540");
    fireEvent.keyDown(rowB, { key: "ArrowRight" });
    await waitFor(() => expect((screen.getByLabelText("X") as HTMLInputElement).value).toBe("541"));
    fireEvent.keyDown(rowB, { key: "ArrowDown", shiftKey: true });
    await waitFor(() => expect((screen.getByLabelText("Y") as HTMLInputElement).value).toBe("685"));
    fireEvent.keyDown(rowB, { key: "Delete" });
    await waitFor(() => expect(layerNames()).toEqual(["a"]));
  });

  it("undoes with Ctrl+Z", async () => {
    renderView();
    await openProject("Market");
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
    const rowB = within(layerList()).getAllByRole("listitem")[0] as HTMLElement;
    fireEvent.pointerDown(rowB, { button: 0 });
    fireEvent.pointerUp(rowB);
    await userEvent.click(screen.getByRole("button", { name: "Backward" }));
    expect(layerNames()).toEqual(["a", "b"]);
    await userEvent.click(screen.getByRole("button", { name: "Front" }));
    expect(layerNames()).toEqual(["b", "a"]);
  });

  it("reorders layers by dragging a row", async () => {
    renderView();
    await openProject("Market");
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
    const rowB = within(layerList()).getAllByRole("listitem")[0] as HTMLElement;
    fireEvent.pointerDown(rowB, { button: 0 });
    fireEvent.pointerUp(rowB);
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
    expect(layerNames()[0]).toBe("Text");
    expect(screen.getByLabelText("Edit text")).toBeTruthy();
  });
});

describe("remove background", () => {
  const job = (status: string, outputs: Array<{ path: string }> = [], extra: Partial<Job> = {}): Job =>
    ({ id: "job1", moduleId: "bg-remover", title: "", status, progress: 0, message: "", inputs: [], outputs, error: "", errorHint: "", ...extra }) as unknown as Job;

  async function selectB() {
    renderView();
    await openProject("Market");
    const rowB = within(layerList()).getAllByRole("listitem")[0] as HTMLElement;
    fireEvent.pointerDown(rowB, { button: 0 });
    fireEvent.pointerUp(rowB);
  }

  it("swaps in the cut-out when the job is done and restores the original", async () => {
    m.removeBg.mockResolvedValue(job(JobStatus.JobRunning));
    await selectB();
    await userEvent.click(screen.getAllByRole("button", { name: "Remove background" })[0] as HTMLElement);
    expect(m.removeBg).toHaveBeenCalledWith("C:/photos/b.jpg");
    expect(screen.getAllByRole("status", { name: "Removing background" }).length).toBeGreaterThan(0);

    act(() => useJobs.getState().upsert(job(JobStatus.JobDone, [{ path: "C:/out/b-cut.png" }])));
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
    expect(layerNames()).toEqual(["b", "a"]);
    await userEvent.click(screen.getByRole("button", { name: "Back to post" }));
    await waitFor(() => expect(useUI.getState().handoff?.moduleId).toBe("post-builder"));
    expect(useUI.getState().handoff?.postSlide).toEqual({ ...slide, projectId: "p1" });
    expect(m.postsSave).not.toHaveBeenCalled();
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
