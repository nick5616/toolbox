import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const slide = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    kind: "photo",
    path: `/p/${id}.jpg`,
    projectId: "",
    panX: 0,
    panY: 0,
    zoom: 1,
    rotation: 0,
    inMs: 0,
    outMs: 0,
    mute: false,
    altText: "",
    ...extra,
  });
  const src = (name: string, extra: Record<string, unknown> = {}) => ({
    path: `/trip/${name}`,
    name,
    rel: name,
    kind: /\.(mp4|mov)$/.test(name) ? "clip" : "photo",
    sizeBytes: 10,
    modTime: 1,
    takenAt: 1,
    usedIn: [] as string[],
    missing: false,
    ...extra,
  });
  const post = (slides: unknown[], extra: Record<string, unknown> = {}) => ({
    version: 1,
    format: "carousel",
    aspect: "4:5",
    slides,
    caption: "",
    keepLocation: false,
    folder: "/trip",
    subfolders: false,
    extra: [],
    hidden: [],
    ...extra,
  });
  return {
    slide,
    src,
    post,
    doc: { current: post([]) as Record<string, unknown> },
    sources: { current: [] as ReturnType<typeof src>[] },
    sourcesError: { current: null as unknown },
    info: (id: string, name = "Trip") => ({ id, kind: "post", name, thumb: "", items: 3, missing: 0, updatedAt: 1 }),
    save: vi.fn(async (id: string, name: string, _d: unknown) => ({ id, kind: "post", name, thumb: "", items: 3, missing: 0, updatedAt: 2 })),
    sourcesFn: vi.fn(),
    createFromFolder: vi.fn(),
    slideInfo: vi.fn(),
    pickWith: vi.fn(),
    pickFolder: vi.fn(),
    stat: vi.fn(),
    imageThumb: vi.fn(async (_p: string, _d: number) => "data:image/png;base64,AA=="),
    frame: vi.fn(async (_p: string, _ms: number, _d: number) => "/media/t/frame.jpg"),
    posts: { current: [] as unknown[] },
  };
});

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    PostsService: {
      List: async () => h.posts.current,
      Limits: async () => ({ maxSlides: 20, maxClipMs: 60000, maxReelMs: 180000, maxCaptionChars: 2200, maxHashtags: 30, maxMentions: 20, minWidth: 1080, frameWidth: 1080, maxAltTextChars: 1000 }),
      Get: async () => structuredClone(h.doc.current),
      Save: (...a: [string, string, unknown]) => h.save(...a),
      Check: async () => [],
      Create: async () => h.info("p9"),
      CreateFromFolder: (...a: unknown[]) => h.createFromFolder(...a),
      Sources: async (id: string) => {
        h.sourcesFn(id);
        if (h.sourcesError.current) throw h.sourcesError.current;
        return structuredClone(h.sources.current);
      },
      SlideInfo: (...a: unknown[]) => h.slideInfo(...a),
      Duplicate: async (id: string) => h.info(`${id}-copy`, "Copy"),
      Delete: async () => undefined,
    },
    ComposerService: { List: async () => [], LoadImage: async () => "" },
    VideoEditorService: { List: async () => [] },
    FilesService: {
      ImageThumb: (p: string, d: number) => h.imageThumb(p, d),
      PickWith: (...a: unknown[]) => h.pickWith(...a),
      PickFolder: (...a: unknown[]) => h.pickFolder(...a),
      Stat: (...a: unknown[]) => h.stat(...a),
    },
    MediaService: { Frame: (p: string, ms: number, d: number) => h.frame(p, ms, d) },
    LibraryService: { RevealPath: async () => undefined, OpenLibraryFolder: async () => undefined },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    JobsService: { Cancel: async () => undefined },
    ModulesService: { Match: async () => ({ matches: [] }) },
  };
});

vi.mock("@/components/media", async (orig) => {
  const actual = await orig<typeof import("@/components/media")>();
  const React = await import("react");
  return {
    ...actual,
    useMediaSource: () => ({ retry: vi.fn(), status: "idle" }),
    MediaPlayer: React.forwardRef(function MediaPlayerStub() {
      return <div data-testid="player" />;
    }),
    Timeline: () => <div data-testid="timeline" />,
  };
});

import { useToastStore } from "@/components/toast";
import type { PostSourceFile } from "@/lib/api";
import { routeFilesDropped } from "@/shell/dropRouting";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { cancelSourceDrag } from "./sourceDrag";
import { CollageDialog, StitchDialog } from "./buildDialogs";
import { DEFAULT_SOURCE_VIEW, clickSelection, hideFromPool, stripDrop, viewSources } from "./pool";
import PostBuilderView from "./PostBuilderView";
import { SourceGrid } from "./SourceGrid";
import { clearSourceCaches } from "./sourceThumbs";
import { useAddToPost, usePostDrop } from "./store";
import { clearVisualCache } from "./useSlideVisual";

const toasts = () => useToastStore.getState().toasts.map((t) => t.title);

async function open() {
  render(<PostBuilderView moduleId="post-builder" />);
  await screen.findByRole("region", { name: "Slides" });
  await screen.findByRole("complementary", { name: "Sources" });
}

function options() {
  return within(screen.getByRole("listbox", { name: "Sources" })).queryAllByRole("option");
}
function slideCount() {
  return within(screen.getByRole("region", { name: "Slides" })).queryAllByRole("button", { name: /^Slide \d/ }).length;
}
function lastSaved(): { slides: { id: string; kind: string; path: string; projectId: string; outMs: number }[]; extra: string[]; hidden: string[]; folder: string } {
  return h.save.mock.calls[h.save.mock.calls.length - 1]![2] as never;
}

beforeEach(() => {
  clearVisualCache();
  clearSourceCaches();
  h.doc.current = h.post([]);
  h.posts.current = [h.info("p1")];
  h.sources.current = ["a.jpg", "b.jpg", "c.jpg", "d.mp4"].map((n) => h.src(n));
  h.sourcesError.current = null;
  h.save.mockClear();
  h.sourcesFn.mockClear();
  h.createFromFolder.mockReset();
  h.slideInfo.mockReset();
  h.slideInfo.mockImplementation(async (paths: string[]) =>
    paths.map((p) => ({ path: p, kind: p.endsWith(".mp4") ? "clip" : "photo", width: 10, height: 10, durationMs: p.endsWith(".mp4") ? 8000 : 0, hasGps: false, heic: false, error: "" })),
  );
  h.pickWith.mockReset();
  h.pickFolder.mockReset();
  h.stat.mockReset();
  h.stat.mockResolvedValue([]);
  h.imageThumb.mockClear();
  h.frame.mockClear();
  useUI.setState({ handoff: null, view: "post-builder" });
  useToastStore.setState({ toasts: [] });
  useAddToPost.setState({ target: "" });
  usePostDrop.setState({ dropped: false });
});

afterEach(() => {
  cancelSourceDrag();
  cleanup();
  vi.unstubAllGlobals();
});

describe("pure source logic", () => {
  const list = [
    h.src("b.jpg", { takenAt: 30, usedIn: ["s1"] }),
    h.src("a.mp4", { takenAt: 20 }),
    h.src("10.jpg", { takenAt: 10 }),
    h.src("9.jpg", { takenAt: 10 }),
  ] as PostSourceFile[];

  it("sorts by date taken (then name) or by name, and filters", () => {
    expect(viewSources(list, DEFAULT_SOURCE_VIEW).map((s) => s.name)).toEqual(["9.jpg", "10.jpg", "a.mp4", "b.jpg"]);
    expect(viewSources(list, { ...DEFAULT_SOURCE_VIEW, sort: "name" }).map((s) => s.name)).toEqual(["9.jpg", "10.jpg", "a.mp4", "b.jpg"]);
    expect(viewSources(list, { ...DEFAULT_SOURCE_VIEW, filter: "clips" }).map((s) => s.name)).toEqual(["a.mp4"]);
    expect(viewSources(list, { ...DEFAULT_SOURCE_VIEW, filter: "photos" })).toHaveLength(3);
    expect(viewSources(list, { ...DEFAULT_SOURCE_VIEW, filter: "unused" }).map((s) => s.name)).not.toContain("b.jpg");
    expect(viewSources(list, { ...DEFAULT_SOURCE_VIEW, search: " B." }).map((s) => s.name)).toEqual(["b.jpg"]);
  });

  it("click, toggle and range selection", () => {
    const order = ["a", "b", "c", "d"];
    let r = clickSelection(order, new Set(), "", "b", { shift: false, toggle: false });
    expect([...r.selected]).toEqual(["b"]);
    r = clickSelection(order, r.selected, r.anchor, "d", { shift: true, toggle: false });
    expect([...r.selected]).toEqual(["b", "c", "d"]);
    r = clickSelection(order, r.selected, r.anchor, "a", { shift: false, toggle: true });
    expect([...r.selected]).toEqual(["b", "c", "d", "a"]);
    r = clickSelection(order, r.selected, r.anchor, "a", { shift: false, toggle: true });
    expect([...r.selected]).toEqual(["b", "c", "d"]);
  });

  it("hit-tests the strip: the middle of a photo replaces, the edges insert", () => {
    const rects = [
      { top: 0, bottom: 100 },
      { top: 110, bottom: 210 },
      { top: 220, bottom: 320 },
    ];
    const kinds = ["photo", "composition", "clip"];
    expect(stripDrop(rects, kinds, 50)).toEqual({ kind: "replace", index: 0 });
    expect(stripDrop(rects, kinds, 160)).toEqual({ kind: "insert", index: 2 }); // composition: never replaced
    expect(stripDrop(rects, kinds, 105)).toEqual({ kind: "insert", index: 1 });
    expect(stripDrop(rects, kinds, 315)).toEqual({ kind: "insert", index: 3 });
    expect(stripDrop(rects, kinds, 270)).toEqual({ kind: "replace", index: 2 });
    expect(stripDrop([], [], 5)).toEqual({ kind: "insert", index: 0 });
  });

  it("hiding sends folder files to Hidden and removes extras", () => {
    const sources = [h.src("a.jpg"), h.src("x.jpg", { rel: "", path: "/other/x.jpg" })] as PostSourceFile[];
    const r = hideFromPool({ extra: ["/other/x.jpg"], hidden: [] }, sources, ["/trip/a.jpg", "/other/x.jpg"]);
    expect(r).toEqual({ extra: [], hidden: ["/trip/a.jpg"] });
  });
});

describe("SourceGrid", () => {
  type Observed = { el: Element; cb: IntersectionObserverCallback };
  let observed: Observed[] = [];

  function mockObserver() {
    observed = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        cb: IntersectionObserverCallback;
        constructor(cb: IntersectionObserverCallback) {
          this.cb = cb;
        }
        observe(el: Element) {
          observed.push({ el, cb: this.cb });
        }
        disconnect() {}
        unobserve() {}
        takeRecords() {
          return [];
        }
      },
    );
  }
  function reveal(name: string) {
    const o = observed.find((x) => x.el.getAttribute("aria-label") === name)!;
    act(() => o.cb([{ isIntersecting: true, target: o.el } as IntersectionObserverEntry], {} as IntersectionObserver));
  }

  function Harness({ sources, onSel, initial = [] }: { sources: PostSourceFile[]; onSel?: (s: Set<string>) => void; initial?: string[] }) {
    const [sel, setSel] = useState<ReadonlySet<string>>(new Set(initial));
    return (
      <SourceGrid
        sources={sources}
        selected={sel}
        onSelectionChange={(n) => {
          setSel(n);
          onSel?.(n);
        }}
        slideNumbers={{ s2: 2, s5: 5 }}
        highlighted={new Set(["/trip/b.jpg"])}
      />
    );
  }
  const grid = () =>
    ["a.jpg", "b.jpg", "c.jpg", "d.mp4"].map((n) => h.src(n, n === "b.jpg" ? { usedIn: ["s5", "s2", "gone"] } : {})) as PostSourceFile[];

  it("loads thumbnails and clip durations only for tiles that have been seen", async () => {
    mockObserver();
    render(<Harness sources={grid()} />);
    await act(async () => {});
    expect(h.imageThumb).not.toHaveBeenCalled();
    expect(h.frame).not.toHaveBeenCalled();
    reveal("a.jpg");
    await waitFor(() => expect(h.imageThumb).toHaveBeenCalledTimes(1));
    expect(h.imageThumb.mock.calls[0]![0]).toBe("/trip/a.jpg");
    reveal("d.mp4");
    await waitFor(() => expect(h.frame).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("duration").textContent).toBe("0:08"));
    expect(h.slideInfo).toHaveBeenCalledWith(["/trip/d.mp4"]);
    expect(h.imageThumb).toHaveBeenCalledTimes(1);
  });

  it("shows 'Used in 2, 5' using slide numbers and highlights a slide's sources", () => {
    render(<Harness sources={grid()} />);
    expect(screen.getByText("Used in 2, 5")).toBeTruthy();
    expect(screen.getByRole("option", { name: "b.jpg" }).getAttribute("data-highlighted")).toBe("true");
    expect(screen.getByRole("option", { name: "a.jpg" }).getAttribute("data-highlighted")).toBeNull();
  });

  it("is a multiselectable listbox: click, Ctrl-click, Shift-click and arrows", async () => {
    render(<Harness sources={grid()} />);
    const user = userEvent.setup();
    const sel = () => screen.getAllByRole("option").filter((o) => o.getAttribute("aria-selected") === "true").map((o) => o.getAttribute("aria-label"));
    expect(screen.getByRole("listbox", { name: "Sources" }).getAttribute("aria-multiselectable")).toBe("true");
    await user.click(screen.getByRole("option", { name: "b.jpg" }));
    expect(sel()).toEqual(["b.jpg"]);
    await user.keyboard("{Control>}");
    await user.click(screen.getByRole("option", { name: "d.mp4" }));
    await user.keyboard("{/Control}");
    expect(sel()).toEqual(["b.jpg", "d.mp4"]);
    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("option", { name: "a.jpg" }));
    await user.keyboard("{/Shift}");
    expect(sel()).toEqual(["a.jpg", "b.jpg", "c.jpg", "d.mp4"]); // the range runs from the anchor (d.mp4) to a.jpg
  });

  it("arrow keys move and extend the selection", async () => {
    render(<Harness sources={grid()} initial={["/trip/a.jpg"]} />);
    const lb = screen.getByRole("listbox", { name: "Sources" });
    lb.focus();
    const sel = () => screen.getAllByRole("option").filter((o) => o.getAttribute("aria-selected") === "true").map((o) => o.getAttribute("aria-label"));
    fireEvent.keyDown(lb, { key: "ArrowRight" });
    expect(sel()).toEqual(["b.jpg"]);
    fireEvent.keyDown(lb, { key: "ArrowRight", shiftKey: true });
    expect(sel()).toEqual(["b.jpg", "c.jpg"]);
    fireEvent.keyDown(lb, { key: "End" });
    expect(sel()).toEqual(["d.mp4"]);
    fireEvent.keyDown(lb, { key: "a", ctrlKey: true });
    expect(sel()).toHaveLength(4);
  });

  it("shows the empty label", () => {
    render(<SourceGrid sources={[]} selected={new Set()} onSelectionChange={() => undefined} emptyLabel="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeTruthy();
  });
});

describe("Sources panel", () => {
  it("lists the pool, shows usage and filters", async () => {
    h.doc.current = h.post([h.slide("s1", { path: "/trip/a.jpg" }), h.slide("s2", { path: "/trip/b.jpg" })]);
    h.sources.current = [h.src("a.jpg", { usedIn: ["s1"] }), h.src("b.jpg", { usedIn: ["s2"] }), h.src("c.jpg"), h.src("d.mp4")];
    await open();
    await waitFor(() => expect(options()).toHaveLength(4));
    expect(screen.getByText("Used in 1")).toBeTruthy();
    expect(screen.getByText("Used in 2")).toBeTruthy();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Show sources" }), "unused");
    expect(options().map((o) => o.getAttribute("aria-label"))).toEqual(["c.jpg", "d.mp4"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Show sources" }), "clips");
    expect(options().map((o) => o.getAttribute("aria-label"))).toEqual(["d.mp4"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Show sources" }), "all");
    await user.type(screen.getByRole("textbox", { name: "Search sources" }), "c.");
    expect(options().map((o) => o.getAttribute("aria-label"))).toEqual(["c.jpg"]);
  });

  it("highlights the sources of the selected slide", async () => {
    h.doc.current = h.post([h.slide("s1", { path: "/trip/a.jpg" }), h.slide("s2", { path: "/trip/b.jpg" })]);
    await open();
    await waitFor(() => expect(options()).toHaveLength(4));
    const marked = () => options().filter((o) => o.getAttribute("data-highlighted") === "true").map((o) => o.getAttribute("aria-label"));
    expect(marked()).toEqual(["a.jpg"]);
    await userEvent.setup().click(screen.getByRole("button", { name: "Slide 2, Photo" }));
    expect(marked()).toEqual(["b.jpg"]);
  });

  it("reports a missing folder with its hint", async () => {
    h.sourcesError.current = { code: "not_found", message: "The source folder isn't there any more", hint: "Choose it again" };
    await open();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The source folder isn't there any more");
    expect(alert.textContent).toContain("Choose it again");
  });

  it("Change folder… saves the new folder; Add files… adds extras; Hide hides and Show restores", async () => {
    await open();
    await waitFor(() => expect(options()).toHaveLength(4));
    const user = userEvent.setup();
    h.pickFolder.mockResolvedValue("/other");
    await user.click(screen.getByRole("button", { name: "Change folder…" }));
    await waitFor(() => expect(h.save).toHaveBeenCalled(), { timeout: 3000 });
    expect(lastSaved().folder).toBe("/other");

    h.pickWith.mockResolvedValue(["/elsewhere/x.jpg"]);
    await user.click(screen.getByRole("button", { name: "Add files…" }));
    await waitFor(() => expect(lastSaved().extra).toEqual(["/elsewhere/x.jpg"]), { timeout: 3000 });

    await user.click(screen.getByRole("option", { name: "c.jpg" }));
    await user.click(screen.getByRole("button", { name: "Hide" }));
    await waitFor(() => expect(lastSaved().hidden).toEqual(["/trip/c.jpg"]), { timeout: 3000 });
    await user.click(screen.getByRole("button", { name: "Show hidden (1)" }));
    await user.click(screen.getByRole("button", { name: "Show c.jpg" }));
    await waitFor(() => expect(lastSaved().hidden).toEqual([]), { timeout: 3000 });
  });
});

describe("allocation", () => {
  it("Add as slides adds one slide per selected source", async () => {
    await open();
    await waitFor(() => expect(options()).toHaveLength(4));
    const user = userEvent.setup();
    await user.click(screen.getByRole("option", { name: "a.jpg" }));
    await user.keyboard("{Control>}");
    await user.click(screen.getByRole("option", { name: "d.mp4" }));
    await user.keyboard("{/Control}");
    await user.click(screen.getByRole("button", { name: /^Add as slides/ }));
    await waitFor(() => expect(slideCount()).toBe(2));
    await waitFor(() => expect(h.save).toHaveBeenCalled(), { timeout: 3000 });
    const slides = lastSaved().slides;
    expect(slides.map((s) => [s.kind, s.path])).toEqual([
      ["photo", "/trip/a.jpg"],
      ["clip", "/trip/d.mp4"],
    ]);
    expect(slides[1]!.outMs).toBe(8000);
  });

  it("enforces the 20 slide limit with a clear message", async () => {
    h.doc.current = h.post(Array.from({ length: 19 }, (_, i) => h.slide(`s${i}`)));
    await open();
    await waitFor(() => expect(options()).toHaveLength(4));
    const user = userEvent.setup();
    await user.click(screen.getByRole("option", { name: "a.jpg" }));
    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("option", { name: "c.jpg" }));
    await user.keyboard("{/Shift}");
    await user.click(screen.getByRole("button", { name: /^Add as slides/ }));
    await waitFor(() => expect(slideCount()).toBe(20));
    expect(toasts()).toContain("Only 1 more fit in this post");

    await user.click(screen.getByRole("button", { name: /^Add as slides/ }));
    await waitFor(() => expect(toasts()).toContain("A post holds at most 20 slides"));
    expect(slideCount()).toBe(20);
  });

  describe("dragging onto the strip", () => {
    function layoutTiles() {
      // jsdom has no layout: give each slide tile a 100 px box, 110 px apart.
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        const tile = this.hasAttribute("data-slide-tile");
        if (!tile) return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
        const i = Array.from(this.parentElement!.children).indexOf(this);
        return { top: i * 110, bottom: i * 110 + 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: i * 110, toJSON() {} } as DOMRect;
      });
    }
    function drag(from: string, y: number) {
      const strip = screen.getByRole("region", { name: "Slides" });
      document.elementFromPoint = () => strip;
      const opt = screen.getByRole("option", { name: from });
      const ev = (type: string, cx: number, cy: number) => {
        const e = new MouseEvent(type, { clientX: cx, clientY: cy, bubbles: true, button: 0 }) as MouseEvent & { pointerId: number };
        Object.defineProperty(e, "pointerId", { value: 1 });
        return e;
      };
      fireEvent(opt, ev("pointerdown", 5, 5));
      act(() => {
        window.dispatchEvent(ev("pointermove", 50, y));
      });
      expect(strip.hasAttribute("data-source-over")).toBe(true);
      act(() => {
        window.dispatchEvent(ev("pointerup", 50, y));
      });
    }

    afterEach(() => vi.restoreAllMocks());

    it("inserts at the position between slides", async () => {
      h.doc.current = h.post([h.slide("s1"), h.slide("s2"), h.slide("s3")]);
      await open();
      await waitFor(() => expect(options()).toHaveLength(4));
      layoutTiles();
      drag("c.jpg", 108); // the gap before slide 2's middle: top edge of tile 2 (y 110..210)
      await waitFor(() => expect(slideCount()).toBe(4));
      await waitFor(() => expect(h.save).toHaveBeenCalled(), { timeout: 3000 });
      expect(lastSaved().slides.map((s) => s.path)).toEqual(["/p/s1.jpg", "/trip/c.jpg", "/p/s2.jpg", "/p/s3.jpg"]);
    });

    it("replaces a photo slide's source when dropped on its middle", async () => {
      h.doc.current = h.post([h.slide("s1"), h.slide("s2")]);
      await open();
      await waitFor(() => expect(options()).toHaveLength(4));
      layoutTiles();
      drag("d.mp4", 160); // middle of tile 2 (110..210)
      await waitFor(() => expect(h.save).toHaveBeenCalled(), { timeout: 3000 });
      const slides = lastSaved().slides;
      expect(slides).toHaveLength(2);
      expect(slides[0]!.path).toBe("/p/s1.jpg");
      expect(slides[1]).toMatchObject({ id: "s2", kind: "clip", path: "/trip/d.mp4", outMs: 8000 });
    });
  });
});

describe("Make a collage and Stitch into a video", () => {
  it("collage dialog → a composition slide and the exact handoff", async () => {
    await open();
    await waitFor(() => expect(options()).toHaveLength(4));
    const user = userEvent.setup();
    await user.click(screen.getByRole("option", { name: "b.jpg" }));
    await user.keyboard("{Control>}");
    await user.click(screen.getByRole("option", { name: "a.jpg" }));
    await user.click(screen.getByRole("option", { name: "c.jpg" }));
    await user.keyboard("{/Control}");
    await user.click(screen.getByRole("button", { name: "Make a collage…" }));
    const dlg = await screen.findByRole("dialog", { name: "Make a collage" });
    await user.click(within(dlg).getByRole("combobox", { name: "Layout" }));
    await user.selectOptions(within(dlg).getByRole("combobox", { name: "Layout" }), "polaroids");
    await user.click(within(dlg).getByRole("button", { name: "Make collage" }));

    await waitFor(() => expect(useUI.getState().handoff?.moduleId).toBe("photo-composer"));
    const ho = useUI.getState().handoff!;
    expect(ho.inputs).toEqual(["/trip/b.jpg", "/trip/a.jpg", "/trip/c.jpg"]);
    expect(ho.postSlide).toEqual({
      postId: "p1",
      slideId: expect.any(String),
      aspect: "4:5",
      projectId: "",
      build: { kind: "collage", background: "/trip/b.jpg", color: "#f3eee6", cutouts: true, layout: "polaroids" },
    });
    // The slide exists and was saved with the pending placeholder.
    const saved = lastSaved().slides;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: ho.postSlide!.slideId, kind: "composition", projectId: "pending" });
  });

  it("collage is disabled for fewer than two photos and for reels", async () => {
    await open();
    await waitFor(() => expect(options()).toHaveLength(4));
    const user = userEvent.setup();
    await user.click(screen.getByRole("option", { name: "a.jpg" }));
    expect((screen.getByRole("button", { name: "Make a collage…" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    h.doc.current = h.post([], { format: "reel", aspect: "9:16" });
    await open();
    await waitFor(() => expect(options()).toHaveLength(4));
    await user.click(screen.getByRole("option", { name: "a.jpg" }));
    await user.keyboard("{Control>}");
    await user.click(screen.getByRole("option", { name: "b.jpg" }));
    await user.keyboard("{/Control}");
    expect((screen.getByRole("button", { name: "Make a collage…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("stitch dialog → a video slide and the exact handoff", async () => {
    h.pickWith.mockResolvedValue(["/music/song.mp3"]);
    await open();
    await waitFor(() => expect(options()).toHaveLength(4));
    const user = userEvent.setup();
    await user.click(screen.getByRole("option", { name: "d.mp4" }));
    await user.keyboard("{Control>}");
    await user.click(screen.getByRole("option", { name: "a.jpg" }));
    await user.keyboard("{/Control}");
    await user.click(screen.getByRole("button", { name: "Stitch into a video…" }));
    const dlg = await screen.findByRole("dialog", { name: "Stitch into a video" });
    await user.click(within(dlg).getByRole("radio", { name: "As selected" }));
    await user.click(within(dlg).getByRole("button", { name: "Choose a song…" }));
    await screen.findByText("song.mp3");
    await user.selectOptions(within(dlg).getByRole("combobox", { name: "Transition" }), "slide");
    await user.click(within(dlg).getByRole("button", { name: "Make video" }));

    await waitFor(() => expect(useUI.getState().handoff?.moduleId).toBe("video-editor"));
    const ho = useUI.getState().handoff!;
    expect(ho.inputs).toEqual(["/trip/d.mp4", "/trip/a.jpg"]);
    expect(ho.postSlide).toEqual({
      postId: "p1",
      slideId: expect.any(String),
      aspect: "4:5",
      projectId: "",
      build: { kind: "stitch", music: "/music/song.mp3", beatCut: true, order: "as-given", transition: "slide" },
    });
    expect(lastSaved().slides[0]).toMatchObject({ kind: "video", projectId: "pending" });
  });

  it("the dialogs return their build settings", async () => {
    const onCollage = vi.fn();
    const photos = [
      { path: "/a.jpg", name: "a.jpg" },
      { path: "/b.jpg", name: "b.jpg" },
    ];
    render(<CollageDialog photos={photos} onConfirm={onCollage} onClose={() => undefined} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: /A colour/ }));
    await user.click(screen.getByRole("switch", { name: "Cut out the others" }));
    await user.click(screen.getByRole("button", { name: "Make collage" }));
    expect(onCollage).toHaveBeenCalledWith({ kind: "collage", background: "", color: "#f3eee6", cutouts: false, layout: "scatter" });
    cleanup();
    const onStitch = vi.fn();
    render(<StitchDialog count={3} onConfirm={onStitch} onClose={() => undefined} />);
    await user.click(screen.getByRole("button", { name: "Make video" }));
    expect(onStitch).toHaveBeenCalledWith({ kind: "stitch", music: "", beatCut: false, order: "date-taken", transition: "fade" });
  });
});

describe("new post from a folder", () => {
  it("is the primary choice in the New post dialog", async () => {
    h.createFromFolder.mockResolvedValue(h.info("p2", "trip-2026"));
    h.pickFolder.mockResolvedValue("/photos/trip-2026");
    await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New post" }));
    const dlg = await screen.findByRole("dialog", { name: "New post" });
    expect(within(dlg).getByRole("radio", { name: "From a folder" }).getAttribute("aria-checked")).toBe("true");
    expect((within(dlg).getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(dlg).getByRole("button", { name: "From a folder…" }));
    await user.click(await within(dlg).findByRole("switch", { name: "Include subfolders" }));
    await user.click(within(dlg).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(h.createFromFolder).toHaveBeenCalled());
    expect(h.createFromFolder.mock.calls[0]).toEqual(["trip-2026", "carousel", "4:5", "/photos/trip-2026", true]);
  });
});

describe("dropping on the page", () => {
  function drop(paths: string[], targetId = "") {
    routeFilesDropped({ paths, targetId, result: { matches: null, unmatched: null } } as never);
  }
  beforeEach(() => {
    useModules.getState().setAll([
      { id: "post-builder", name: "Post Builder", status: "ready", accepts: { extensions: [".jpg", ".mp4"], urls: false, any: false } } as never,
    ]);
  });
  afterEach(() => useModules.getState().setAll([]));

  it("a folder drop creates a post from the folder", async () => {
    h.stat.mockResolvedValue([{ path: "/photos/Lisbon", name: "Lisbon", sizeBytes: 0, exists: true, isDir: true, kind: "" }]);
    h.createFromFolder.mockResolvedValue(h.info("p2", "Lisbon"));
    await open();
    drop(["/photos/Lisbon"]);
    await waitFor(() => expect(h.createFromFolder).toHaveBeenCalled());
    expect(h.createFromFolder.mock.calls[0]).toEqual(["Lisbon", "carousel", "4:5", "/photos/Lisbon", false]);
    expect(useUI.getState().handoff).toBeNull();
  });

  it("dropped files become extra sources, not slides", async () => {
    await open();
    await waitFor(() => expect(options()).toHaveLength(4));
    drop(["/elsewhere/x.jpg", "/elsewhere/y.mp4"]);
    await waitFor(() => expect(h.save).toHaveBeenCalled(), { timeout: 3000 });
    expect(lastSaved().extra).toEqual(["/elsewhere/x.jpg", "/elsewhere/y.mp4"]);
    expect(lastSaved().slides).toHaveLength(0);
    expect(slideCount()).toBe(0);
  });

  it("does not interfere with other pages", () => {
    useUI.setState({ view: "library" });
    drop(["/a.jpg"]);
    expect(h.stat).not.toHaveBeenCalled();
    expect(useUI.getState().drop).not.toBeNull();
  });
});
