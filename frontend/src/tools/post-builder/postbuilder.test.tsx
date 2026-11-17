import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  const post = (slides: unknown[]) => ({ version: 1, format: "carousel", aspect: "4:5", slides, caption: "", keepLocation: false });
  return {
    slide,
    post,
    doc: { current: post([slide("a"), slide("b"), slide("c")]) as Record<string, unknown> },
    issues: { current: [] as { level: string; slideId: string; message: string }[] },
    info: (id: string, name = "Trip") => ({ id, kind: "post", name, thumb: "", items: 3, missing: 0, updatedAt: 1 }),
    save: vi.fn(async (id: string, name: string, _d: unknown) => ({ id, kind: "post", name, thumb: "", items: 3, missing: 0, updatedAt: 2 })),
    check: vi.fn(async (_d: unknown) => [] as unknown[]),
    exportFn: vi.fn(),
    create: vi.fn(),
    slideInfo: vi.fn(),
    pickWith: vi.fn(),
    reveal: vi.fn(async (_p: string) => undefined),
    popOut: vi.fn(async (_r: unknown) => undefined),
    getCalls: vi.fn(),
    setState: vi.fn(async (..._a: unknown[]) => undefined),
    savedState: { current: "" },
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
      Get: async () => {
        h.getCalls();
        return structuredClone(h.doc.current);
      },
      Save: (...a: [string, string, unknown]) => h.save(...a),
      Check: (d: unknown) => h.check(d),
      Create: (...a: unknown[]) => h.create(...a),
      Export: (...a: unknown[]) => h.exportFn(...a),
      SlideInfo: (...a: unknown[]) => h.slideInfo(...a),
      Duplicate: async (id: string) => h.info(`${id}-copy`, "Copy"),
      Delete: async () => undefined,
    },
    ComposerService: { List: async () => [], LoadImage: async () => "" },
    VideoEditorService: { List: async () => [] },
    FilesService: { ImageThumb: async () => "data:image/png;base64,AA==", PickWith: (...a: unknown[]) => h.pickWith(...a), Stat: async () => [] },
    MediaService: { Frame: async () => "/media/t/frame.jpg" },
    LibraryService: { RevealPath: (p: string) => h.reveal(p), OpenLibraryFolder: async () => undefined },
    SettingsService: { ModuleState: async () => h.savedState.current, SetModuleState: (...a: unknown[]) => h.setState(...a) },
    JobsService: { Cancel: async () => undefined },
    DesktopService: { PopOut: (r: unknown) => h.popOut(r), OpenWindows: async () => [], Relay: async () => undefined },
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
import { JobStatus, type Job } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { useWindows } from "@/state/windows";
import { useUI } from "@/state/ui";
import { sendToItems } from "@/views/LibraryView";
import { AddToPostDialog } from "./AddToPostDialog";
import PostBuilderView from "./PostBuilderView";
import { clearVisualCache } from "./useSlideVisual";
import { useAddToPost } from "./store";
import { usePostBuilder } from "./postStore";

function renderView() {
  return render(<PostBuilderView moduleId="post-builder" />);
}

async function open() {
  renderView();
  await screen.findByRole("region", { name: "Slides" });
  await waitFor(() => expect(selectedIndex()).toBeGreaterThanOrEqual(0));
}

/** Opens a click-in drawer by its launcher (one drawer is open at a time). */
async function showPanel(name: string) {
  const launcher = screen.getByRole("button", { name: new RegExp(`^${name}`) });
  if (launcher.getAttribute("aria-expanded") !== "true") await userEvent.click(launcher);
  await screen.findByRole("dialog", { name });
}

function slideButtons() {
  return within(screen.getByRole("region", { name: "Slides" })).getAllByRole("button", { name: /^Slide \d/ });
}

function selectedIndex(): number {
  return slideButtons().findIndex((b) => b.getAttribute("aria-current") === "true");
}

/** The last document handed to PostsService.Save. */
function lastSaved(): { slides: { id: string; projectId: string; kind: string }[]; caption: string; aspect: string; format: string } {
  const call = h.save.mock.calls[h.save.mock.calls.length - 1];
  return call![2] as never;
}

beforeEach(() => {
  clearVisualCache();
  h.doc.current = h.post([h.slide("a"), h.slide("b"), h.slide("c")]);
  h.posts.current = [h.info("p1")];
  h.savedState.current = "";
  h.check.mockImplementation(async () => h.issues.current);
  h.issues.current = [];
  h.save.mockClear();
  h.setState.mockClear();
  h.exportFn.mockReset();
  h.create.mockReset();
  h.slideInfo.mockReset();
  h.pickWith.mockReset();
  h.reveal.mockClear();
  h.popOut.mockClear();
  h.getCalls.mockClear();
  useWindows.setState({ open: [] });
  useUI.setState({ handoff: null, view: "post-builder" });
  useJobs.setState({ byId: {} });
  useToastStore.setState({ toasts: [] });
  useAddToPost.setState({ target: "" });
});

afterEach(() => {
  cleanup();
  usePostBuilder.getState().reset(); // leaving the tool keeps the post (and its undo steps) in memory
});

describe("slides", () => {
  it("shows the slides in order with the first selected", async () => {
    await open();
    expect(slideButtons()).toHaveLength(3);
    expect(selectedIndex()).toBe(0);
  });

  it("selects a slide from anywhere on its tile", async () => {
    await open();
    const tile = (i: number) => slideButtons()[i]!.closest("li")!;
    // Beside the thumbnail, not on it.
    fireEvent.pointerDown(tile(2), { button: 0, pointerId: 1, clientY: 100 });
    fireEvent.pointerUp(tile(2), { button: 0, pointerId: 1, clientY: 100 });
    expect(selectedIndex()).toBe(2);
    // The action buttons don't select or drag.
    fireEvent.pointerDown(screen.getByRole("button", { name: "Move earlier" }), { button: 0, pointerId: 2, clientY: 100 });
    fireEvent.pointerUp(screen.getByRole("button", { name: "Move earlier" }), { button: 0, pointerId: 2, clientY: 100 });
    expect(selectedIndex()).toBe(2);
  });

  it("steps through the slides with the arrow keys and moves one with Alt", async () => {
    await open();
    const list = slideButtons()[0]!.closest("ol")!;
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(selectedIndex()).toBe(1);
    fireEvent.keyDown(list, { key: "ArrowUp" });
    fireEvent.keyDown(list, { key: "ArrowUp" }); // already first
    expect(selectedIndex()).toBe(0);
    fireEvent.keyDown(list, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(h.save).toHaveBeenCalled(), { timeout: 3000 });
    expect(lastSaved().slides.map((s) => s.id)).toEqual(["b", "a", "c"]);
    expect(selectedIndex()).toBe(1);
  });

  it("reorders with Move later and autosaves once, 800 ms after the last edit", async () => {
    await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Move later" }));
    await user.click(screen.getByRole("button", { name: "Move later" }));
    expect(h.save).not.toHaveBeenCalled();
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(lastSaved().slides.map((s) => s.id)).toEqual(["b", "c", "a"]);
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
  });

  it("deletes a slide and selects its neighbour", async () => {
    await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete slide" }));
    expect(slideButtons()).toHaveLength(2);
    expect(selectedIndex()).toBe(0);
    await waitFor(() => expect(h.save).toHaveBeenCalled(), { timeout: 3000 });
    expect(lastSaved().slides.map((s) => s.id)).toEqual(["b", "c"]);
  });

  it("duplicates a slide", async () => {
    await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Duplicate slide" }));
    expect(slideButtons()).toHaveLength(4);
    expect(selectedIndex()).toBe(1);
  });

  it("adds photos and clips from the picker", async () => {
    h.pickWith.mockResolvedValue(["/new/x.jpg"]);
    h.slideInfo.mockResolvedValue([{ path: "/new/x.jpg", kind: "photo", width: 4000, height: 3000, durationMs: 0, hasGps: false, heic: false, error: "" }]);
    await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(await screen.findByRole("menuitem", { name: /Photos & clips/ }));
    await waitFor(() => expect(slideButtons()).toHaveLength(4));
    expect(selectedIndex()).toBe(3);
    expect(h.slideInfo).toHaveBeenCalledWith(["/new/x.jpg"]);
  });

  it("flags slides with issues", async () => {
    h.issues.current = [{ level: "error", slideId: "b", message: "The file is missing" }];
    await open();
    await screen.findByTestId("issue-b");
  });
});

describe("caption and alt text", () => {
  it("counts characters, hashtags and mentions", async () => {
    await open();
    const user = userEvent.setup();
    await showPanel("Caption");
    expect(screen.getByTestId("chars-left").textContent).toContain("2,200");
    await user.click(screen.getByRole("textbox", { name: "Caption" }));
    await user.paste("Hello @bob #one #two");
    expect(screen.getByTestId("chars-left").textContent).toContain("2,180");
    expect(screen.getByTestId("hashtags").textContent).toContain("2/30");
    expect(screen.getByTestId("mentions").textContent).toContain("1 mention");
    await waitFor(() => expect(h.save).toHaveBeenCalled(), { timeout: 3000 });
    expect(lastSaved().caption).toBe("Hello @bob #one #two");
  });

  it("edits the alt text of the selected slide", async () => {
    await open();
    expect(screen.getByRole("button", { name: /^Alt text/ }).getAttribute("data-tip")).toContain("Slide 1 · empty");
    await showPanel("Alt text");
    const user = userEvent.setup();
    await user.click(screen.getByRole("textbox", { name: "Alt text" }));
    await user.paste("A beach");
    expect((screen.getByRole("textbox", { name: "Alt text" }) as HTMLTextAreaElement).value).toBe("A beach");
  });

  it("shows the phone preview beside the stage and keeps the rest in the rail with summaries", async () => {
    await open();
    expect(screen.getByRole("region", { name: "Phone preview" })).toBeTruthy();
    for (const [name, text] of [["Format", "Carousel · 4:5"], ["Sources", "No folder"], ["Checks", "All clear"], ["Caption", "Empty"]] as const) {
      expect(screen.getByRole("button", { name: new RegExp(`^${name}`) }).getAttribute("data-tip")).toContain(text);
    }
  });
});

describe("checks", () => {
  it("lists issues and selects the slide when one is clicked", async () => {
    h.issues.current = [
      { level: "warning", slideId: "c", message: "May look soft" },
      { level: "note", slideId: "", message: "Location will be removed" },
    ];
    await open();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Checks/ }).getAttribute("data-tip")).toContain("2 notes"));
    await showPanel("Checks");
    const checks = await screen.findByRole("region", { name: "Checks" });
    const item = await within(checks).findByRole("button", { name: /May look soft/ });
    expect(within(checks).getByText(/Location will be removed/)).toBeTruthy();
    await userEvent.setup().click(item);
    expect(selectedIndex()).toBe(2);
  });
});

describe("export", () => {
  it("is disabled while the checks have an error, and says why", async () => {
    h.issues.current = [{ level: "error", slideId: "", message: "Add at least one slide" }];
    await open();
    await waitFor(() => expect((screen.getByRole("button", { name: "Export" }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByTestId("export-blocker").getAttribute("data-blocked")).toBe("true");
  });

  it("starts the export and ends in a draggable result row with Send to", async () => {
    h.exportFn.mockResolvedValue({ id: "j1", moduleId: "post-builder", status: JobStatus.JobRunning, progress: 0, message: "", inputs: [], outputs: [], resultJson: "" } as unknown as Job);
    await open();
    const user = userEvent.setup();
    await waitFor(() => expect((screen.getByRole("button", { name: "Export" }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(h.exportFn).toHaveBeenCalledWith("p1"));
    await screen.findByRole("progressbar");

    act(() => {
      useJobs.getState().upsert({ id: "j1", moduleId: "post-builder", status: JobStatus.JobDone, progress: 1, message: "", resultJson: JSON.stringify({ folder: "/lib/Posts/Trip 2026-11-01", files: ["/lib/Posts/Trip 2026-11-01/1.jpg", "/lib/Posts/Trip 2026-11-01/2.jpg"] }) } as unknown as Job);
    });
    const row = await screen.findByTestId("last-export");
    expect(within(row).getByText("Trip 2026-11-01")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Send to…" })).toBeTruthy();
    expect(row.getAttribute("draggable")).toBe("true");
    const data: Record<string, string> = {};
    fireEvent.dragStart(row, { dataTransfer: { setData: (k: string, v: string) => (data[k] = v), types: [] } });
    expect(JSON.parse(data["application/x-toolbox-paths"] ?? "[]")).toEqual(["/lib/Posts/Trip 2026-11-01/1.jpg", "/lib/Posts/Trip 2026-11-01/2.jpg"]);

    // The folder is remembered (by name in the menu), with Copy caption beside it.
    await user.click(await screen.findByRole("button", { name: "More export actions" }));
    expect(await screen.findByRole("menuitem", { name: "Open last export (Trip 2026-11-01)" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Copy caption" })).toBeTruthy();
    const saved = JSON.parse(h.setState.mock.calls[h.setState.mock.calls.length - 1]![1] as string) as { exports: Record<string, string> };
    expect(saved.exports.p1).toBe("/lib/Posts/Trip 2026-11-01");
  });
});

describe("composition and video slides", () => {
  it("New composition saves a placeholder slide and hands off to Photo Composer", async () => {
    await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(await screen.findByRole("menuitem", { name: "New composition" }));
    await waitFor(() => expect(useUI.getState().handoff?.moduleId).toBe("photo-composer"));
    const ho = useUI.getState().handoff!;
    expect(ho.inputs).toEqual([]);
    expect(ho.postSlide).toMatchObject({ postId: "p1", aspect: "4:5", projectId: "" });
    const doc = lastSaved();
    expect(doc.slides).toHaveLength(4);
    const added = doc.slides[3]!;
    expect(added.id).toBe(ho.postSlide!.slideId);
    expect(added.kind).toBe("composition");
    expect(added.projectId).not.toBe("");
  });

  it("New video hands off to Video Editor at the post's shape", async () => {
    h.doc.current = { ...h.post([h.slide("a")]), aspect: "1:1" };
    await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(await screen.findByRole("menuitem", { name: "New video" }));
    await waitFor(() => expect(useUI.getState().handoff?.moduleId).toBe("video-editor"));
    expect(useUI.getState().handoff?.postSlide).toMatchObject({ postId: "p1", aspect: "1:1", projectId: "" });
  });

  it("Edit on a linked composition hands off with its project id", async () => {
    h.doc.current = h.post([h.slide("a", { kind: "composition", path: "", projectId: "proj-9" })]);
    await open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit here" }));
    await waitFor(() => expect(useUI.getState().handoff?.moduleId).toBe("photo-composer"));
    expect(useUI.getState().handoff?.postSlide).toEqual({ postId: "p1", slideId: "a", aspect: "4:5", projectId: "proj-9" });
    expect(h.popOut).not.toHaveBeenCalled();
  });

  it("Edit in its own window opens the tool window with the same handoff, and refreshes when it closes", async () => {
    h.doc.current = h.post([h.slide("a", { kind: "video", path: "", projectId: "vid-3" })]);
    await open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit in its own window" }));
    await waitFor(() => expect(h.popOut).toHaveBeenCalledTimes(1));
    const req = h.popOut.mock.calls[0]![0] as { key: string; query: string; handoff: string };
    expect(req.key).toBe("tool:video-editor");
    expect(JSON.parse(req.handoff)).toEqual({ moduleId: "video-editor", inputs: [], postSlide: { postId: "p1", slideId: "a", aspect: "4:5", projectId: "vid-3" } });
    expect(useUI.getState().handoff).toBeNull();

    // The window opens, then closes: the post is reloaded from disk.
    act(() => useWindows.setState({ open: ["tool:video-editor"] }));
    const before = h.getCalls.mock.calls.length;
    act(() => useWindows.setState({ open: [] }));
    await waitFor(() => expect(h.getCalls.mock.calls.length).toBeGreaterThan(before));
  });

  it("refreshes the post when this window is focused again after editing elsewhere", async () => {
    h.doc.current = h.post([h.slide("a", { kind: "composition", path: "", projectId: "proj-9" })]);
    await open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit in its own window" }));
    await waitFor(() => expect(h.popOut).toHaveBeenCalled());
    const before = h.getCalls.mock.calls.length;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(h.getCalls.mock.calls.length).toBeGreaterThan(before));
  });

  it("a pending composition offers to make it here or in its own window", async () => {
    h.doc.current = h.post([h.slide("a", { kind: "composition", path: "", projectId: "pending" })]);
    await open();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Make it in its own window" }));
    await waitFor(() => expect(h.popOut).toHaveBeenCalledTimes(1));
    expect((h.popOut.mock.calls[0]![0] as { key: string }).key).toBe("tool:photo-composer");
  });

  it("a postSlide handoff coming back selects that slide", async () => {
    useUI.setState({ handoff: { moduleId: "post-builder", inputs: [], postSlide: { postId: "p1", slideId: "c", aspect: "4:5", projectId: "proj-1" } } });
    await open();
    await waitFor(() => expect(selectedIndex()).toBe(2));
    expect(useUI.getState().handoff).toBeNull();
  });
});

describe("handoffs with files", () => {
  it("adds handed-over files to the open post", async () => {
    h.slideInfo.mockResolvedValue([{ path: "/lib/x.png", kind: "photo", width: 1, height: 1, durationMs: 0, hasGps: false, heic: false, error: "" }]);
    useUI.setState({ handoff: { moduleId: "post-builder", inputs: ["/lib/x.png"] } });
    await open();
    await waitFor(() => expect(slideButtons()).toHaveLength(4));
    expect(selectedIndex()).toBe(3);
  });

  it("starts a new post when the Library chose 'New post'", async () => {
    h.create.mockResolvedValue(h.info("p2", "Carousel"));
    useAddToPost.setState({ target: "new" });
    useUI.setState({ handoff: { moduleId: "post-builder", inputs: ["/lib/x.png"] } });
    await open();
    await waitFor(() => expect(h.create).toHaveBeenCalledTimes(1));
    expect(h.create.mock.calls[0]![1]).toBe("carousel");
    expect(h.create.mock.calls[0]![3]).toEqual(["/lib/x.png"]);
  });
});

describe("Library: Add to post", () => {
  it("offers Add to post… in Send to when the tool is ready", async () => {
    useModules.getState().setAll([
      { id: "post-builder", name: "Post Builder", status: "ready", accepts: { extensions: [".jpg", ".mp4"], urls: false, any: false } } as never,
    ]);
    const items = await sendToItems("/lib/photo.jpg");
    expect(items.map((i) => i.label)).toContain("Add to post…");
    const none = await sendToItems("/lib/notes.txt");
    expect(none.map((i) => i.label)).not.toContain("Add to post…");
    useModules.getState().setAll([]);
  });

  it("the dialog sets the target post and hands the file to Post Builder", async () => {
    const onClose = vi.fn();
    render(<AddToPostDialog path="/lib/photo.jpg" posts={[h.info("p1") as never, h.info("p7", "Market") as never]} onClose={onClose} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: /Market/ }));
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(useAddToPost.getState().target).toBe("p7");
    expect(useUI.getState().handoff).toEqual({ moduleId: "post-builder", inputs: ["/lib/photo.jpg"] });
    expect(onClose).toHaveBeenCalled();
  });

  it("choosing New post sets the 'new' target", async () => {
    render(<AddToPostDialog path="/lib/a.jpg" posts={[h.info("p1") as never]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: /New post/ }));
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(useAddToPost.getState().target).toBe("new");
  });
});

describe("phone preview", () => {
  it("swipes with the arrow keys and truncates the caption with 'more'", async () => {
    h.doc.current = { ...h.post([h.slide("a"), h.slide("b"), h.slide("c")]), caption: "w".repeat(300) };
    await open();
    const phone = screen.getByLabelText("Swipe with the arrow keys");
    fireEvent.keyDown(phone, { key: "ArrowRight" });
    await waitFor(() => expect(selectedIndex()).toBe(1));
    fireEvent.keyDown(phone, { key: "ArrowLeft" });
    await waitFor(() => expect(selectedIndex()).toBe(0));
    const cap = screen.getByTestId("phone-caption");
    expect(cap.textContent).toContain("… more");
    await userEvent.setup().click(within(cap).getByRole("button", { name: "more" }));
    expect(screen.getByTestId("phone-caption").textContent).toBe("w".repeat(300));
  });
});

describe("posts", () => {
  it("opens the last post from module state and offers New post", async () => {
    h.posts.current = [h.info("p1"), h.info("p2", "Market")];
    h.savedState.current = JSON.stringify({ lastPostId: "p2", exports: {} });
    await open();
    await showPanel("Posts");
    expect(screen.getByRole("button", { name: "Open Market" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: "New post" })).toBeTruthy();
  });

  it("creates a post from the New post dialog", async () => {
    h.create.mockResolvedValue(h.info("p3", "Reel"));
    await open();
    const user = userEvent.setup();
    await showPanel("Posts");
    await user.click(screen.getByRole("button", { name: "New post" }));
    const dlg = await screen.findByRole("dialog", { name: "New post" });
    await user.click(within(dlg).getByRole("radio", { name: "Empty post" }));
    await user.click(within(dlg).getByRole("radio", { name: "Reel" }));
    await user.click(within(dlg).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(h.create).toHaveBeenCalled());
    expect(h.create.mock.calls[0]![1]).toBe("reel");
    expect(h.create.mock.calls[0]![2]).toBe("9:16");
  });
});
