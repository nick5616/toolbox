import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  drop: null as null | ((i: { paths: string[]; x: number; y: number }) => void),
  reveal: vi.fn(),
}));

vi.mock("@/blocks/sources/sourceDrag", () => ({
  startSourceDrag: () => undefined,
  useSourceDropTarget: (_ref: unknown, onDrop: (i: { paths: string[]; x: number; y: number }) => void) => {
    h.drop = onDrop;
  },
  useSourceDrag: () => undefined,
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    EditStudioService: { Probe: async () => [{ path: "/song.mp3", durationMs: 100_000 }], Sources: async () => [], Mattes: async () => [] },
    MediaService: { Filmstrip: async () => "/media/t/strip.jpg", URLFor: async () => "/media/t/x", Waveform: async () => [0.2, 0.9, 0.4, 0.6] },
    FilesService: { ImageThumb: async () => "data:image/jpeg;base64,AA==" },
    LibraryService: { RevealPath: (...a: unknown[]) => h.reveal(...a) },
  };
});

import type { EditClip, EditSourceState } from "@/lib/api";
import { emptyEditProject, type NormalProject } from "@/viz/edit/defaults";
import { newClip } from "@/editor/doc";
import { useEditStudio } from "@/editor/store";
import type { EditorProfile } from "../profile";
import { EditorProfileProvider, PLAIN_PROFILE } from "../profileContext";
import { TracksPanel } from "./TracksPanel";

const vid = (id: string, startMs: number, endMs: number, over: Partial<EditClip> = {}): EditClip => newClip({ id, kind: "video", path: "/c/a.mp4", startMs, endMs, ...over });

function open(clips: EditClip[], tweak: (d: NormalProject) => void = () => undefined): void {
  const doc = emptyEditProject("9:16", 30, 1) as NormalProject;
  doc.song = { path: "/song.mp3", startMs: 0, endMs: 20_000, gainDb: 0, fadeInMs: 0, fadeOutMs: 500 };
  doc.tracks = [
    { id: "t1", kind: "video", name: "Video 1", muted: false, locked: false, matte: "", clips },
    { id: "t2", kind: "adjust", name: "Adjust 1", muted: false, locked: false, matte: "", clips: [] },
  ];
  tweak(doc);
  useEditStudio.getState().open("p1", "Edit", doc);
  useEditStudio.getState().setView(100, 0);
  useEditStudio.getState().setSnap(false);
}
const project = () => useEditStudio.getState().history!.present;
const clipsOf = (id = "t1") => (project().tracks.find((t) => t.id === id)?.clips ?? []).slice().sort((a, b) => a.startMs - b.startMs);
const spans = (id = "t1") => clipsOf(id).map((c) => [c.startMs, c.endMs]);
const clipEl = (id: string) => document.querySelector(`[data-clip-id="${id}"]`) as HTMLElement;

const sourceState = (path: string, durationMs: number): EditSourceState => ({
  path,
  info: { path, kind: "video", durationMs, width: 1920, height: 1080, fps: 30, rotation: 0, hasAudio: false, takenAt: 0, error: "" },
  preview: { stream: "/s", index: "/i", width: 540, height: 960, fps: 30, frames: 100 },
  image: "",
  shots: null,
  preparing: false,
  error: "",
});

let realRect: typeof Element.prototype.getBoundingClientRect;
beforeEach(() => {
  h.reveal.mockReset();
  h.drop = null;
  useEditStudio.getState().close();
  realRect = Element.prototype.getBoundingClientRect;
  // Two track rows at known places: t2 (adjust) above t1.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const id = (this as HTMLElement).dataset?.trackRow;
    if (id === "t2") return { top: 0, bottom: 36, left: 168, right: 1168, width: 1000, height: 36, x: 168, y: 0, toJSON: () => ({}) };
    if (id === "t1") return { top: 36, bottom: 92, left: 168, right: 1168, width: 1000, height: 56, x: 168, y: 36, toJSON: () => ({}) };
    return realRect.call(this);
  };
});
afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
  cleanup();
});

describe("TracksPanel layout", () => {
  it("shows tracks top first, headers, clips and the song track", async () => {
    open([vid("a", 0, 1000)]);
    render(<TracksPanel />);
    const names = screen.getAllByText(/^(Video 1|Adjust 1)$/).map((n) => n.textContent);
    expect(names).toEqual(["Adjust 1", "Video 1"]);
    expect(clipEl("a")).toBeTruthy();
    expect(document.querySelector("[data-song-row]")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Fade in length" })).toBeTruthy();
  });

  it("flags clips that run past the end of the edit", () => {
    open([vid("a", 19_000, 22_000)]);
    render(<TracksPanel />);
    expect(clipEl("a").getAttribute("data-tip")).toMatch(/past the end/);
  });

  it("one Add menu adds tracks (up to 8) and text, and disables the track items at the limit", async () => {
    open([]);
    render(<TracksPanel />);
    expect(screen.queryByRole("button", { name: "Track" })).toBeNull(); // no row of add buttons any more
    const add = async (name: string) => {
      await userEvent.click(screen.getByRole("button", { name: "Add" }));
      await userEvent.click(await screen.findByRole("menuitem", { name }));
    };
    await add("Video track");
    expect(project().tracks.map((t) => t.name)).toEqual(["Video 1", "Adjust 1", "Video 2"]);
    await add("Adjustment track");
    expect(project().tracks).toHaveLength(4);
    for (let i = 0; i < 4; i++) await add("Video track");
    expect(project().tracks).toHaveLength(8);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const item = await screen.findByRole("menuitem", { name: "Video track" });
    expect(item.getAttribute("aria-disabled") === "true" || (item as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("menuitem", { name: "Visual" })).toBeNull(); // visuals need the music layer
  });

  it("the music layer's profile adds Visual to the menu", async () => {
    open([]);
    render(
      <EditorProfileProvider profile={{ ...PLAIN_PROFILE, markerSignals: true }}>
        <TracksPanel />
      </EditorProfileProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("menuitem", { name: "Visual" })).toBeTruthy();
  });

  it("track header: mute, lock, rename, remove (with a confirm when it has clips)", async () => {
    open([vid("a", 0, 1000)]);
    render(<TracksPanel />);
    const header = document.querySelector('[data-track-header="t1"]') as HTMLElement;
    await userEvent.click(within(header).getByRole("button", { name: "Mute track" }));
    expect(project().tracks[0]?.muted).toBe(true);
    await userEvent.click(within(header).getByRole("button", { name: "Lock track" }));
    expect(project().tracks[0]?.locked).toBe(true);
    await userEvent.dblClick(within(header).getByText("Video 1"));
    const box = within(header).getByRole("textbox", { name: "Track name" });
    await userEvent.clear(box);
    await userEvent.type(box, "Main{Enter}");
    expect(project().tracks[0]?.name).toBe("Main");
    await userEvent.click(within(header).getByRole("button", { name: "Actions for Main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove track" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(project().tracks.map((t) => t.id)).toEqual(["t2"]);
  });
});

describe("selection", () => {
  it("click selects; Shift adds; Ctrl/Cmd toggles", () => {
    open([vid("a", 0, 1000), vid("b", 2000, 3000), vid("c", 4000, 5000)]);
    render(<TracksPanel />);
    fireEvent.pointerDown(clipEl("a"), { button: 0 });
    fireEvent.pointerUp(window);
    expect(useEditStudio.getState().selection).toEqual({ kind: "clips", ids: ["a"] });
    fireEvent.pointerDown(clipEl("c"), { button: 0, shiftKey: true });
    expect(useEditStudio.getState().selection).toEqual({ kind: "clips", ids: ["a", "c"] });
    fireEvent.pointerDown(clipEl("a"), { button: 0, ctrlKey: true });
    expect(useEditStudio.getState().selection).toEqual({ kind: "clips", ids: ["c"] });
    fireEvent.pointerDown(clipEl("c"), { button: 0, ctrlKey: true });
    expect(useEditStudio.getState().selection).toBeNull();
  });

  it("marquee on empty space selects the clips it crosses", () => {
    open([vid("a", 0, 1000), vid("b", 3000, 4000)]);
    render(<TracksPanel />);
    const area = document.querySelector('[data-track-row="t1"]') as HTMLElement;
    fireEvent.pointerDown(area, { button: 0, clientX: 168 + 200, clientY: 60 });
    fireEvent.pointerMove(window, { clientX: 168 + 20, clientY: 50 });
    fireEvent.pointerUp(window, { clientX: 168 + 20, clientY: 50 });
    expect(useEditStudio.getState().selection).toEqual({ kind: "clips", ids: ["a"] });
  });

  it("a click on empty space selects the track and moves the playhead", () => {
    open([vid("a", 0, 1000)]);
    render(<TracksPanel />);
    const area = document.querySelector('[data-track-row="t1"]') as HTMLElement;
    fireEvent.pointerDown(area, { button: 0, clientX: 168 + 250, clientY: 60 });
    fireEvent.pointerUp(window, { clientX: 168 + 250, clientY: 60 });
    expect(useEditStudio.getState().selection).toEqual({ kind: "track", id: "t1" });
    expect(useEditStudio.getState().playheadMs).toBe(2500);
  });
});

describe("dragging", () => {
  it("moves a clip: one undo step for the whole drag", () => {
    open([vid("a", 0, 1000), vid("b", 5000, 6000)]);
    render(<TracksPanel />);
    const before = useEditStudio.getState().history!.past.length;
    fireEvent.pointerDown(clipEl("a"), { button: 0, clientX: 10, clientY: 60 });
    fireEvent.pointerMove(window, { clientX: 60, clientY: 60 });
    fireEvent.pointerMove(window, { clientX: 110, clientY: 60 });
    fireEvent.pointerMove(window, { clientX: 210, clientY: 60 });
    fireEvent.pointerUp(window, { clientX: 210, clientY: 60 });
    expect(spans()).toEqual([[2000, 3000], [5000, 6000]]);
    expect(useEditStudio.getState().history!.past.length).toBe(before + 1);
    act(() => useEditStudio.getState().undo());
    expect(spans()).toEqual([[0, 1000], [5000, 6000]]);
  });

  it("a pause mid-drag still makes one undo step", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      open([vid("a", 0, 1000)]);
      render(<TracksPanel />);
      const before = useEditStudio.getState().history!.past.length;
      fireEvent.pointerDown(clipEl("a"), { button: 0, clientX: 10, clientY: 60 });
      fireEvent.pointerMove(window, { clientX: 110, clientY: 60 });
      vi.setSystemTime(Date.now() + 2000);
      fireEvent.pointerMove(window, { clientX: 210, clientY: 60 });
      vi.setSystemTime(Date.now() + 2000);
      fireEvent.pointerMove(window, { clientX: 310, clientY: 60 });
      expect(useEditStudio.getState().history!.past.length).toBeGreaterThan(before + 1);
      fireEvent.pointerUp(window);
      expect(useEditStudio.getState().history!.past.length).toBe(before + 1);
      expect(spans()).toEqual([[3000, 4000]]);
      act(() => useEditStudio.getState().undo());
      expect(spans()).toEqual([[0, 1000]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not move before a 4 px threshold, and overwrites what it lands on", () => {
    open([vid("a", 0, 1000), vid("b", 2000, 3000)]);
    render(<TracksPanel />);
    fireEvent.pointerDown(clipEl("a"), { button: 0, clientX: 10, clientY: 60 });
    fireEvent.pointerMove(window, { clientX: 12, clientY: 60 });
    expect(spans()[0]).toEqual([0, 1000]);
    fireEvent.pointerMove(window, { clientX: 10 + 150, clientY: 60 }); // +1.5 s: lands on b
    fireEvent.pointerUp(window);
    expect(spans()).toEqual([[1500, 2500], [2500, 3000]]);
  });

  it("snaps the dragged clip to another clip's edge and names the target", () => {
    open([vid("a", 0, 1000), vid("b", 3000, 4000)]);
    useEditStudio.getState().setSnap(true);
    render(<TracksPanel />);
    fireEvent.pointerDown(clipEl("a"), { button: 0, clientX: 10, clientY: 60 });
    fireEvent.pointerMove(window, { clientX: 10 + 195, clientY: 60 }); // end at 2950, b starts at 3000
    expect(spans()[0]).toEqual([2000, 3000]);
    expect(screen.getByText("clip edge")).toBeTruthy();
    fireEvent.pointerUp(window);
    expect(screen.queryByText("clip edge")).toBeNull();
  });

  it("Alt bypasses snapping", () => {
    open([vid("a", 0, 1000), vid("b", 3000, 4000)]);
    useEditStudio.getState().setSnap(true);
    render(<TracksPanel />);
    fireEvent.pointerDown(clipEl("a"), { button: 0, clientX: 10, clientY: 60 });
    fireEvent.pointerMove(window, { clientX: 10 + 195, clientY: 60, altKey: true });
    fireEvent.pointerUp(window);
    expect(spans()[0]).toEqual([1950, 2950]);
  });

  it("moves a clip onto another track", () => {
    open([vid("a", 0, 1000)], (d) => {
      d.tracks.push({ id: "t3", kind: "video", name: "Video 2", muted: false, locked: false, matte: "", clips: [] });
    });
    // Rows: t1 36..92 (mocked); t3 has no mocked rect, so drag within t1 only; moving across needs a rect.
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if ((this as HTMLElement).dataset?.trackRow === "t3") return { top: 92, bottom: 148, left: 168, right: 1168, width: 1000, height: 56, x: 168, y: 92, toJSON: () => ({}) };
      return orig.call(this);
    };
    render(<TracksPanel />);
    fireEvent.pointerDown(clipEl("a"), { button: 0, clientX: 10, clientY: 60 });
    fireEvent.pointerMove(window, { clientX: 10, clientY: 120 });
    fireEvent.pointerMove(window, { clientX: 60, clientY: 120 });
    fireEvent.pointerUp(window);
    expect(clipsOf("t1")).toHaveLength(0);
    expect(spans("t3")).toEqual([[500, 1500]]);
  });

  it("does not drag clips of a locked track", () => {
    open([vid("a", 0, 1000)], (d) => {
      (d.tracks[0] as NormalProject["tracks"][number]).locked = true;
    });
    render(<TracksPanel />);
    fireEvent.pointerDown(clipEl("a"), { button: 0, clientX: 10, clientY: 60 });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 60 });
    fireEvent.pointerUp(window);
    expect(spans()).toEqual([[0, 1000]]);
  });

  it("trims the end edge, then the start edge (InMs follows)", () => {
    open([vid("a", 1000, 2000, { inMs: 500 })]);
    useEditStudio.getState().setSnap(false);
    render(<TracksPanel />);
    const end = clipEl("a").querySelector('[data-trim="end"]') as HTMLElement;
    fireEvent.pointerDown(end, { button: 0, clientX: 300 });
    fireEvent.pointerMove(window, { clientX: 350 });
    fireEvent.pointerUp(window);
    expect(spans()).toEqual([[1000, 2500]]);
    const start = clipEl("a").querySelector('[data-trim="start"]') as HTMLElement;
    fireEvent.pointerDown(start, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 130 });
    fireEvent.pointerUp(window);
    expect(clipsOf()[0]).toMatchObject({ startMs: 1300, endMs: 2500, inMs: 800 });
  });

  it("a trim never goes into the neighbour", () => {
    open([vid("a", 0, 1000), vid("b", 1200, 2000)]);
    render(<TracksPanel />);
    const end = clipEl("a").querySelector('[data-trim="end"]') as HTMLElement;
    fireEvent.pointerDown(end, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 400 });
    fireEvent.pointerUp(window);
    expect(spans()[0]).toEqual([0, 1200]);
  });
});

describe("context menu", () => {
  it("lists the clip actions, and Delete removes the clip", async () => {
    open([vid("a", 0, 1000)]);
    render(<TracksPanel />);
    fireEvent.contextMenu(clipEl("a"), { clientX: 50, clientY: 50 });
    const menu = await screen.findByRole("menu");
    const labels = within(menu).getAllByRole("menuitem").map((i) => i.textContent);
    expect(labels).toEqual(["Split at playhead", "Split subject", "Detach audio", "Link", "Pin", "Copy", "Cut", "Paste at playhead", "Duplicate", "Delete", "Ripple delete", "Reveal source"]);
    expect((within(menu).getByRole("menuitem", { name: "Split at playhead" }) as HTMLButtonElement).disabled).toBe(true); // playhead at 0, the clip starts there
    expect((within(menu).getByRole("menuitem", { name: "Split subject" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    expect(clipsOf()).toHaveLength(0);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a profile adds clip menu items (with the markers), toolbar buttons and a rows overlay", async () => {
    open([vid("a", 0, 1000)]);
    const picked: string[] = [];
    const profile: EditorProfile = {
      ...PLAIN_PROFILE,
      clipMenuItems: (clips, ctx) => [{ id: "x", label: `Extra for ${clips.length} (${ctx?.markers.length ?? -1} markers)`, onSelect: () => picked.push(clips[0]?.id ?? "") }],
      TracksToolbar: () => <button type="button">Profile button</button>,
      TracksOverlay: () => <div data-testid="rows-overlay" />,
    };
    render(
      <EditorProfileProvider profile={profile}>
        <TracksPanel />
      </EditorProfileProvider>,
    );
    expect(screen.getByRole("button", { name: "Profile button" })).toBeTruthy();
    expect(screen.getByTestId("rows-overlay")).toBeTruthy();
    fireEvent.contextMenu(clipEl("a"), { clientX: 50, clientY: 50 });
    const menu = await screen.findByRole("menu");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Extra for 1 (0 markers)" }));
    expect(picked).toEqual(["a"]);
  });

  it("splits at the playhead, pins (keeping auto) and duplicates", async () => {
    open([vid("a", 0, 2000, { auto: true })]);
    useEditStudio.getState().setPlayhead(500);
    render(<TracksPanel />);
    fireEvent.contextMenu(clipEl("a"), { clientX: 5, clientY: 5 });
    await userEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
    expect(clipsOf()[0]).toMatchObject({ pinned: true, auto: true });
    fireEvent.contextMenu(clipEl("a"), { clientX: 5, clientY: 5 });
    expect(await screen.findByRole("menuitem", { name: "Unpin" })).toBeTruthy();
    await userEvent.click(screen.getByRole("menuitem", { name: "Split at playhead" }));
    expect(spans()).toEqual([[0, 500], [500, 2000]]);
    fireEvent.contextMenu(clipEl("a"), { clientX: 5, clientY: 5 });
    await userEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
    expect(clipsOf()).toHaveLength(3);
  });

  it("Reveal source reveals the file", async () => {
    h.reveal.mockResolvedValue(undefined);
    open([vid("a", 0, 1000)]);
    render(<TracksPanel />);
    fireEvent.contextMenu(clipEl("a"), { clientX: 5, clientY: 5 });
    await userEvent.click(await screen.findByRole("menuitem", { name: "Reveal source" }));
    expect(h.reveal).toHaveBeenCalledWith("/c/a.mp4");
  });

  it("right-clicking an unselected clip selects it first", () => {
    open([vid("a", 0, 1000), vid("b", 2000, 3000)]);
    useEditStudio.getState().select({ kind: "clips", ids: ["a"] });
    render(<TracksPanel />);
    fireEvent.contextMenu(clipEl("b"), { clientX: 5, clientY: 5 });
    expect(useEditStudio.getState().selection).toEqual({ kind: "clips", ids: ["b"] });
  });
});

describe("adjustment tracks", () => {
  it("double-clicking empty space on one makes an adjustment clip", () => {
    open([]);
    render(<TracksPanel />);
    const area = document.querySelector('[data-track-row="t2"]') as HTMLElement;
    fireEvent.doubleClick(area, { clientX: 168 + 300, clientY: 10 });
    expect(clipsOf("t2")[0]).toMatchObject({ kind: "adjust", startMs: 3000, endMs: 5000 });
  });
});

describe("drops from Sources", () => {
  it("fills to the source's length on a video track; Shift is the same without markers", () => {
    open([]);
    useEditStudio.getState().setSources([sourceState("/c/a.mp4", 4000), sourceState("/c/b.mp4", 3000)]);
    render(<TracksPanel />);
    expect(h.drop).toBeTruthy();
    act(() => h.drop?.({ paths: ["/c/a.mp4", "/c/b.mp4"], x: 168 + 200, y: 60 }));
    expect(spans()).toEqual([[2000, 6000], [6000, 9000]]);
    expect(useEditStudio.getState().selection?.kind).toBe("clips");
  });

  it("refuses a drop on an adjustment track", () => {
    open([]);
    useEditStudio.getState().setSources([sourceState("/c/a.mp4", 4000)]);
    render(<TracksPanel />);
    act(() => h.drop?.({ paths: ["/c/a.mp4"], x: 300, y: 10 }));
    expect(clipsOf()).toHaveLength(0);
  });

  it("never overlaps: a drop on a clip overwrites what is under it", () => {
    open([vid("a", 0, 3000)]);
    useEditStudio.getState().setSources([sourceState("/c/b.mp4", 2000)]);
    render(<TracksPanel />);
    act(() => h.drop?.({ paths: ["/c/b.mp4"], x: 168 + 100, y: 60 }));
    expect(spans()).toEqual([[0, 1000], [1000, 3000]]);
  });

  it("holding Ctrl while dropping inserts: the later clips move right", () => {
    open([vid("a", 0, 3000)]);
    useEditStudio.getState().setSources([sourceState("/c/b.mp4", 2000)]);
    render(<TracksPanel />);
    fireEvent.keyDown(window, { key: "Control", ctrlKey: true });
    act(() => h.drop?.({ paths: ["/c/b.mp4"], x: 168 + 100, y: 60 }));
    expect(spans()).toEqual([[0, 1000], [1000, 3000], [3000, 5000]]);
  });

  it("a drop below the last track makes a new video track", () => {
    open([]);
    useEditStudio.getState().setSources([sourceState("/c/b.mp4", 2000)]);
    render(<TracksPanel />);
    act(() => h.drop?.({ paths: ["/c/b.mp4"], x: 168 + 100, y: 500 }));
    expect(project().tracks).toHaveLength(3);
    expect(project().tracks[2]?.clips).toHaveLength(1);
  });
});

describe("song track", () => {
  it("dragging the fade handles edits the fades (one undo step each)", async () => {
    open([]);
    render(<TracksPanel />);
    const handle = await screen.findByRole("button", { name: "Fade in length" });
    fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 5 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 5 });
    fireEvent.pointerUp(window);
    expect(project().song?.fadeInMs).toBe(3000);
    const out = screen.getByRole("button", { name: "Fade out length" });
    fireEvent.pointerDown(out, { button: 0, clientX: 1900, clientY: 5 });
    fireEvent.pointerMove(window, { clientX: 1800, clientY: 5 });
    fireEvent.pointerUp(window);
    expect(project().song?.fadeOutMs).toBe(2000);
  });

  it("clicking the song track selects it", () => {
    open([]);
    render(<TracksPanel />);
    const row = document.querySelector("[data-song-row]") as HTMLElement;
    fireEvent.pointerDown(row.querySelector("span") as HTMLElement, { button: 0 });
    expect(useEditStudio.getState().selection).toEqual({ kind: "song" });
  });
});
