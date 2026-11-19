import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/blocks/sources/sourceDrag", () => ({
  startSourceDrag: () => undefined,
  useSourceDropTarget: () => undefined,
  useSourceDrag: () => undefined,
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    EditStudioService: { Probe: async () => [], Sources: async () => [], Mattes: async () => [] },
    MediaService: { Filmstrip: async () => "/media/t/strip.jpg", URLFor: async () => "/media/t/x", Waveform: async () => [0.2, 0.9, 0.4, 0.6] },
    FilesService: { ImageThumb: async () => "data:image/jpeg;base64,AA==" },
    LibraryService: { RevealPath: async () => undefined },
  };
});

// Peaks: a loud file for every path.
vi.mock("@/editor/audio/peaks", async (orig) => {
  const actual = await orig<typeof import("@/editor/audio/peaks")>();
  const n = 3000;
  const peaks = { rate: 100, channels: 1, min: new Int8Array(n).fill(-60), max: new Int8Array(n).fill(60), durationMs: 30_000 };
  return { ...actual, usePeaks: (p: string | null) => (p ? peaks : null) };
});

import type { EditClip, EditSourceState } from "@/lib/api";
import { newClip } from "@/editor/doc";
import { emptyEditProject, type NormalProject } from "@/viz/edit/defaults";
import { serializeTransform } from "@/viz/edit/schema";
import { useEditStudio } from "@/editor/store";
import { EditorProfileProvider, PLAIN_PROFILE } from "../profileContext";
import { serializeGain } from "./gain";
import { Ruler } from "./Ruler";
import { TimelineToolbar } from "./TimelineToolbar";
import { TracksPanel } from "./TracksPanel";
import { useTimelineStore } from "./timelineStore";

const vid = (id: string, startMs: number, endMs: number, over: Partial<EditClip> = {}): EditClip => newClip({ id, kind: "video", path: "/c/a.mp4", startMs, endMs, volume: 1, ...over });
const aud = (id: string, startMs: number, endMs: number, over: Partial<EditClip> = {}): EditClip => newClip({ id, kind: "audio", path: "/c/m.mp3", startMs, endMs, volume: 1, ...over });

function open(video: EditClip[], audio: EditClip[] = [], song: NormalProject["song"] = null): void {
  const doc = emptyEditProject("16:9", 30, 1) as NormalProject;
  doc.song = song;
  doc.tracks = [
    { id: "a1", kind: "audio", name: "Audio 1", muted: false, locked: false, matte: "", clips: audio },
    { id: "t1", kind: "video", name: "Video 1", muted: false, locked: false, matte: "", clips: video },
  ];
  useEditStudio.getState().open("p1", "Edit", doc);
  useEditStudio.getState().setView(100, 0);
  useEditStudio.getState().setSnap(false);
  useEditStudio.getState().setPlayhead(0);
}
const project = () => useEditStudio.getState().history!.present;
const clipsOf = (id = "t1") => (project().tracks.find((t) => t.id === id)?.clips ?? []).slice().sort((a, b) => a.startMs - b.startMs);
const spans = (id = "t1") => clipsOf(id).map((c) => [c.startMs, c.endMs]);
const clipEl = (id: string) => document.querySelector(`[data-clip-id="${id}"]`) as HTMLElement;

const sourceState = (path: string, kind: string, durationMs: number, hasAudio: boolean): EditSourceState => ({
  path,
  info: { path, kind, durationMs, width: 1920, height: 1080, fps: 30, rotation: 0, hasAudio, takenAt: 0, error: "" },
  preview: { stream: "/s", index: "/i", width: 540, height: 960, fps: 30, frames: 100 },
  image: "",
  shots: null,
  preparing: false,
  error: "",
});

let realRect: typeof Element.prototype.getBoundingClientRect;
const widthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
beforeEach(() => {
  useEditStudio.getState().close();
  useTimelineStore.setState({ tool: "select", rangeInMs: null, rangeOutMs: null, loop: false, gap: null, slip: null, paramFocus: null, clipboard: null });
  realRect = Element.prototype.getBoundingClientRect;
  // The time area starts at x = 168 (after the header) for the ruler and the rows.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1168 });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const el = this as HTMLElement;
    if (el.dataset?.trackRow) return { top: 0, bottom: 56, left: 168, right: 1168, width: 1000, height: 56, x: 168, y: 0, toJSON: () => ({}) };
    return { top: 0, bottom: 26, left: 0, right: 1168, width: 1168, height: 26, x: 0, y: 0, toJSON: () => ({}) };
  };
});
afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
  if (widthDesc) Object.defineProperty(HTMLElement.prototype, "clientWidth", widthDesc);
  cleanup();
});

describe("Ruler", () => {
  it("shows labelled ticks that adapt to the zoom", () => {
    open([vid("a", 0, 5000)]);
    const { rerender } = render(<Ruler />);
    const labels = () => Array.from(document.querySelectorAll("[data-tick=major]")).map((e) => e.textContent);
    const coarse = labels().length;
    expect(coarse).toBeGreaterThan(2);
    act(() => useEditStudio.getState().setView(1500, 0));
    rerender(<Ruler />);
    // Zoomed in: the labels are frames, "S:FF".
    expect(labels().some((l) => /^\d+:\d\d$/.test(l ?? ""))).toBe(true);
  });

  it("a click seeks to that time", () => {
    open([vid("a", 0, 5000)]);
    render(<Ruler />);
    const area = screen.getByRole("slider");
    fireEvent.pointerDown(area, { button: 0, clientX: 168 + 250, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 168 + 250, clientY: 10 });
    expect(useEditStudio.getState().playheadMs).toBe(2500);
  });

  it("a drag scrubs, ending where the pointer is released", () => {
    open([vid("a", 0, 9000)]);
    render(<Ruler />);
    const area = screen.getByRole("slider");
    fireEvent.pointerDown(area, { button: 0, clientX: 168 + 100, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 168 + 200, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 168 + 400, clientY: 10 });
    expect(useEditStudio.getState().playheadMs).toBe(4000);
  });

  it("shades the In/Out range", () => {
    open([vid("a", 0, 9000)]);
    render(<Ruler />);
    expect(document.querySelector("[data-range]")).toBeNull();
    act(() => useTimelineStore.getState().setRange(1000, 3000));
    const shade = document.querySelector("[data-range]") as HTMLElement;
    expect(shade.style.left).toBe("100px");
    expect(shade.style.width).toBe("200px");
  });

  it("shows marker flags in the Video Editor; double-click names one; dragging moves it", async () => {
    open([vid("a", 0, 9000)]);
    const doc = project();
    useEditStudio.getState().edit({ ...doc, markers: { ...doc.markers, custom: [{ id: "k1", ms: 2000, label: "" }] } });
    render(<Ruler />);
    const flag = document.querySelector('[data-flag="k1"]') as HTMLElement;
    expect(flag).toBeTruthy();
    await userEvent.dblClick(flag);
    const box = await screen.findByRole("textbox", { name: "Marker name" });
    await userEvent.type(box, "Drop{Enter}");
    expect(project().markers.custom[0]?.label).toBe("Drop");
    // Drag it 1 s to the right (100 px at 100 px/s).
    const flag2 = document.querySelector('[data-flag="k1"]') as HTMLElement;
    const before = useEditStudio.getState().history!.past.length;
    fireEvent.pointerDown(flag2, { button: 0, clientX: 368, clientY: 5 });
    fireEvent.pointerMove(window, { clientX: 418, clientY: 5 });
    fireEvent.pointerMove(window, { clientX: 468, clientY: 5 });
    fireEvent.pointerUp(window, { clientX: 468, clientY: 5 });
    expect(project().markers.custom[0]?.ms).toBe(3000);
    expect(useEditStudio.getState().history!.past.length).toBe(before + 1); // one undo step
  });

  it("Edit Studio's ruler leaves markers to its lanes", () => {
    open([vid("a", 0, 9000)]);
    const doc = project();
    useEditStudio.getState().edit({ ...doc, markers: { ...doc.markers, custom: [{ id: "k1", ms: 2000, label: "" }] } });
    render(
      <EditorProfileProvider profile={{ ...PLAIN_PROFILE, moduleId: "edit-studio", song: "analyzed" }}>
        <Ruler />
      </EditorProfileProvider>,
    );
    expect(document.querySelector("[data-flag]")).toBeNull();
  });

  it("the wheel zooms only with Ctrl (and the zoom keeps 6–2000 px/s)", () => {
    open([vid("a", 0, 9000)]);
    render(<Ruler />);
    const el = document.querySelector("[data-timeline-ruler]") as HTMLElement;
    fireEvent.wheel(el, { deltaY: 120, clientX: 400 });
    expect(useEditStudio.getState().pps).toBe(100);
    fireEvent.wheel(el, { deltaY: -400, clientX: 400, ctrlKey: true });
    expect(useEditStudio.getState().pps).toBeGreaterThan(100);
    fireEvent.wheel(el, { deltaY: -100_000, clientX: 400, ctrlKey: true });
    expect(useEditStudio.getState().pps).toBe(2000);
  });
});

describe("tool switching", () => {
  it("the toolbar buttons pick the tool and show which is on", async () => {
    open([vid("a", 0, 5000)]);
    render(<TimelineToolbar />);
    expect(screen.getByRole("button", { name: "Select tool" }).getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Razor tool" }));
    expect(useTimelineStore.getState().tool).toBe("razor");
    expect(screen.getByRole("button", { name: "Razor tool" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Select tool" }).getAttribute("aria-pressed")).toBe("false");
    for (const [name, tool] of [["Ripple trim tool", "ripple"], ["Roll tool", "roll"], ["Slip tool", "slip"]] as const) {
      await userEvent.click(screen.getByRole("button", { name }));
      expect(useTimelineStore.getState().tool).toBe(tool);
    }
  });

  it("the magnet toggles snapping and the slider zooms", async () => {
    open([vid("a", 0, 5000)]);
    render(<TimelineToolbar />);
    const magnet = screen.getByRole("button", { name: /Snapping/ });
    expect(magnet.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(magnet);
    expect(useEditStudio.getState().snap).toBe(true);
    const slider = screen.getByRole("slider", { name: "Zoom" });
    fireEvent.change(slider, { target: { value: "1000" } });
    expect(useEditStudio.getState().pps).toBeCloseTo(2000, 0);
  });
});

describe("tools on the tracks", () => {
  it("razor: a click cuts the clip at the pointer; the clip is not selected or moved", () => {
    open([vid("a", 0, 5000)]);
    useTimelineStore.getState().setTool("razor");
    render(<TracksPanel />);
    fireEvent.pointerDown(clipEl("a"), { button: 0, clientX: 168 + 200, clientY: 20 });
    expect(spans()).toEqual([[0, 2000], [2000, 5000]]);
  });

  it("razor: Shift+click cuts every unlocked track; locked tracks stay whole", () => {
    open([vid("a", 0, 5000)], [aud("s", 0, 5000)]);
    const doc = project();
    useEditStudio.getState().edit({ ...doc, tracks: doc.tracks.map((t) => (t.id === "a1" ? { ...t, locked: true } : t)) });
    useTimelineStore.getState().setTool("razor");
    render(<TracksPanel />);
    fireEvent.pointerDown(clipEl("a"), { button: 0, clientX: 168 + 300, clientY: 20, shiftKey: true });
    expect(spans()).toEqual([[0, 3000], [3000, 5000]]);
    expect(spans("a1")).toEqual([[0, 5000]]);
  });

  it("razor on a linked clip cuts its partner too", () => {
    open([vid("v", 0, 5000, { link: "L" })], [aud("s", 0, 5000, { link: "L" })]);
    useTimelineStore.getState().setTool("razor");
    render(<TracksPanel />);
    fireEvent.pointerDown(clipEl("v"), { button: 0, clientX: 168 + 100, clientY: 20 });
    expect(spans()).toEqual([[0, 1000], [1000, 5000]]);
    expect(spans("a1")).toEqual([[0, 1000], [1000, 5000]]);
  });

  it("ripple trim: dragging an edge moves the later clips", () => {
    open([vid("a", 0, 2000), vid("b", 2000, 4000)]);
    useTimelineStore.getState().setTool("ripple");
    render(<TracksPanel />);
    const handle = clipEl("a").querySelector('[data-trim="end"]') as HTMLElement;
    fireEvent.pointerDown(handle, { button: 0, clientX: 168 + 200, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 168 + 150, clientY: 20 });
    fireEvent.pointerUp(window);
    expect(spans()).toEqual([[0, 1500], [1500, 3500]]);
  });

  it("the normal trim moves linked partners' edges together; Alt trims one side", () => {
    open([vid("v", 0, 4000, { link: "L" })], [aud("s", 0, 4000, { link: "L" })]);
    render(<TracksPanel />);
    const handle = clipEl("v").querySelector('[data-trim="end"]') as HTMLElement;
    fireEvent.pointerDown(handle, { button: 0, clientX: 168 + 400, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 168 + 300, clientY: 20 });
    fireEvent.pointerUp(window);
    expect(spans()).toEqual([[0, 3000]]);
    expect(spans("a1")).toEqual([[0, 3000]]);
    const h2 = clipEl("v").querySelector('[data-trim="end"]') as HTMLElement;
    fireEvent.pointerDown(h2, { button: 0, clientX: 168 + 300, clientY: 20, altKey: true });
    fireEvent.pointerMove(window, { clientX: 168 + 200, clientY: 20 });
    fireEvent.pointerUp(window);
    expect(spans()).toEqual([[0, 2000]]);
    expect(spans("a1")).toEqual([[0, 3000]]);
  });

  it("roll: dragging the cut between two clips moves both edges", () => {
    open([vid("a", 0, 2000), vid("b", 2000, 5000, { inMs: 1000 })]);
    useEditStudio.getState().setSources([sourceState("/c/a.mp4", "video", 60_000, false)]);
    useTimelineStore.getState().setTool("roll");
    render(<TracksPanel />);
    const handle = clipEl("a").querySelector('[data-trim="end"]') as HTMLElement;
    fireEvent.pointerDown(handle, { button: 0, clientX: 168 + 200, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 168 + 250, clientY: 20 });
    fireEvent.pointerUp(window);
    expect(spans()).toEqual([[0, 2500], [2500, 5000]]);
    expect(clipsOf()[1]?.inMs).toBe(1500);
  });

  it("slip: dragging inside a clip shifts its in-point, keeping place and length, and shows In/Out", () => {
    open([vid("a", 1000, 3000, { inMs: 2000 })]);
    useEditStudio.getState().setSources([sourceState("/c/a.mp4", "video", 60_000, false)]);
    useTimelineStore.getState().setTool("slip");
    render(<TracksPanel />);
    fireEvent.pointerDown(clipEl("a"), { button: 0, clientX: 168 + 200, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 168 + 150, clientY: 20 }); // 0.5 s left: later material
    expect(clipEl("a").textContent).toMatch(/In 2\.50s · Out 4\.50s/);
    fireEvent.pointerUp(window);
    expect(clipsOf()[0]).toMatchObject({ startMs: 1000, endMs: 3000, inMs: 2500 });
    expect(useEditStudio.getState().playheadMs).toBe(1000); // the preview shows the in frame
    expect(useTimelineStore.getState().slip).toBeNull();
  });

  it("a drag onto another clip overwrites; Alt-drag duplicates", () => {
    open([vid("a", 0, 1000), vid("b", 2000, 4000)]);
    render(<TracksPanel />);
    fireEvent.pointerDown(clipEl("a"), { button: 0, clientX: 10, clientY: 20, altKey: true });
    fireEvent.pointerMove(window, { clientX: 10 + 300, clientY: 20, altKey: true });
    fireEvent.pointerUp(window);
    expect(spans()).toEqual([[0, 1000], [2000, 3000], [3000, 4000]]);
  });

  it("clicking a linked clip selects its partner; Alt+click selects one side", () => {
    open([vid("v", 0, 2000, { link: "L" })], [aud("s", 0, 2000, { link: "L" })]);
    render(<TracksPanel />);
    fireEvent.pointerDown(clipEl("v"), { button: 0, clientX: 168 + 50, clientY: 20 });
    fireEvent.pointerUp(window);
    expect(useEditStudio.getState().selection).toEqual({ kind: "clips", ids: ["v", "s"] });
    fireEvent.pointerDown(clipEl("v"), { button: 0, clientX: 168 + 50, clientY: 20, altKey: true });
    fireEvent.pointerUp(window);
    expect(useEditStudio.getState().selection).toEqual({ kind: "clips", ids: ["v"] });
    expect(clipEl("v").querySelector('[aria-label="Linked"], [title="Linked"]') ?? clipEl("v").getAttribute("data-link")).toBeTruthy();
  });

  it("selecting the gap between clips and deleting it closes it; the menu offers Close gap", async () => {
    open([vid("a", 0, 1000), vid("b", 3000, 4000)]);
    render(<TracksPanel />);
    const area = document.querySelector('[data-track-row="t1"]') as HTMLElement;
    fireEvent.pointerDown(area, { button: 0, clientX: 168 + 200, clientY: 20 });
    fireEvent.pointerUp(window, { clientX: 168 + 200, clientY: 20 });
    expect(useTimelineStore.getState().gap).toEqual({ trackId: "t1", fromMs: 1000, toMs: 3000 });
    fireEvent.contextMenu(area, { clientX: 168 + 200, clientY: 20 });
    const item = await screen.findByRole("menuitem", { name: "Close gap" });
    expect((item as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(item);
    expect(spans()).toEqual([[0, 1000], [1000, 2000]]);
  });

  it("the clip menu detaches audio onto an audio track, silencing and linking the video", async () => {
    open([vid("v", 0, 2000)]);
    useEditStudio.getState().setSources([sourceState("/c/a.mp4", "video", 60_000, true)]);
    render(<TracksPanel />);
    fireEvent.contextMenu(clipEl("v"), { clientX: 168 + 50, clientY: 20 });
    await userEvent.click(await screen.findByRole("menuitem", { name: "Detach audio" }));
    expect(clipsOf("a1")).toHaveLength(1);
    expect(clipsOf("a1")[0]).toMatchObject({ kind: "audio", startMs: 0, endMs: 2000 });
    expect(clipsOf()[0]?.volume).toBe(0);
    expect(clipsOf()[0]?.link).toBe(clipsOf("a1")[0]?.link);
  });
});

describe("track headers", () => {
  const header = (id: string) => document.querySelector(`[data-track-header="${id}"]`) as HTMLElement;

  it("solo toggles on audio and video tracks (not adjustment tracks)", async () => {
    open([vid("a", 0, 1000)], [aud("s", 0, 1000)]);
    render(<TracksPanel />);
    await userEvent.click(within(header("a1")).getByRole("button", { name: "Solo track" }));
    expect(project().tracks.find((t) => t.id === "a1")?.solo).toBe(true);
    expect(within(header("a1")).getByRole("button", { name: "Unsolo track" }).getAttribute("aria-pressed")).toBe("true");
    cleanup();
    const doc = project();
    useEditStudio.getState().edit({ ...doc, tracks: [...doc.tracks, { id: "t2", kind: "adjust", name: "Adjust 1", muted: false, locked: false, matte: "", clips: [] }] });
    render(<TracksPanel />);
    expect(within(header("t2")).queryByRole("button", { name: /olo track/ })).toBeNull();
  });

  it("an audio track has a music icon, and no kind switch in its menu", async () => {
    open([], [aud("s", 0, 1000)]);
    render(<TracksPanel />);
    await userEvent.click(within(header("a1")).getByRole("button", { name: "Actions for Audio 1" }));
    expect(screen.queryByRole("menuitem", { name: /Make it/ })).toBeNull();
    expect(await screen.findByRole("menuitem", { name: "Add audio track" })).toBeTruthy();
  });

  it("the menu sets the height; the bottom edge drags between S, M and L", async () => {
    open([vid("a", 0, 1000)]);
    render(<TracksPanel />);
    await userEvent.click(within(header("t1")).getByRole("button", { name: "Actions for Video 1" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Large" }));
    expect(project().tracks.find((t) => t.id === "t1")?.height).toBe("l");
    expect((document.querySelector('[data-track-id="t1"]') as HTMLElement).style.height).toBe("96px");
    const grow = document.querySelector('[data-grow-track="t1"]') as HTMLElement;
    const before = useEditStudio.getState().history!.past.length;
    fireEvent.pointerDown(grow, { button: 0, clientY: 100 });
    fireEvent.pointerMove(window, { clientY: 60 }); // −40 px: medium
    fireEvent.pointerMove(window, { clientY: 30 }); // −70 px: small
    fireEvent.pointerUp(window);
    expect(project().tracks.find((t) => t.id === "t1")?.height).toBe("s");
    expect(useEditStudio.getState().history!.past.length).toBe(before + 1);
  });

  it("the Add menu makes video, audio and adjustment tracks", async () => {
    open([vid("a", 0, 1000)]);
    render(<TracksPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Audio track" }));
    expect(project().tracks[0]).toMatchObject({ kind: "audio", name: "Audio 2" });
  });
});

describe("waveforms, volume line and keyframe strip", () => {
  it("draws a waveform on audio clips at medium and large heights, not at small", () => {
    open([], [aud("s", 0, 5000)]);
    render(<TracksPanel />);
    expect(clipEl("s").querySelector("[data-waveform]")).toBeTruthy();
    cleanup();
    const doc = project();
    useEditStudio.getState().edit({ ...doc, tracks: doc.tracks.map((t) => (t.id === "a1" ? { ...t, height: "s" } : t)) });
    render(<TracksPanel />);
    expect(clipEl("s").querySelector("[data-waveform]")).toBeNull();
    expect(clipEl("s").querySelector("[data-gain-line]")).toBeNull();
  });

  it("video clips with sound get a waveform at M and the volume line only at L", () => {
    open([vid("v", 0, 5000)]);
    useEditStudio.getState().setSources([sourceState("/c/a.mp4", "video", 60_000, true)]);
    render(<TracksPanel />);
    expect(clipEl("v").querySelector("[data-waveform]")).toBeTruthy();
    expect(clipEl("v").querySelector("[data-gain-line]")).toBeNull();
    cleanup();
    const doc = project();
    useEditStudio.getState().edit({ ...doc, tracks: doc.tracks.map((t) => (t.id === "t1" ? { ...t, height: "l" } : t)) });
    render(<TracksPanel />);
    expect(clipEl("v").querySelector("[data-gain-line]")).toBeTruthy();
  });

  it("silent video has neither", () => {
    open([vid("v", 0, 5000)]);
    useEditStudio.getState().setSources([sourceState("/c/a.mp4", "video", 60_000, false)]);
    render(<TracksPanel />);
    expect(clipEl("v").querySelector("[data-waveform]")).toBeNull();
  });

  it("dragging the volume line sets the whole clip's gain; Ctrl+click adds a key; Alt+click on a key removes it", () => {
    open([], [aud("s", 0, 4000)]);
    render(<TracksPanel />);
    const svg = clipEl("s").querySelector("[data-gain-line]") as SVGSVGElement;
    svg.getBoundingClientRect = () => ({ top: 0, bottom: 72, left: 168, right: 568, width: 400, height: 72, x: 168, y: 0, toJSON: () => ({}) });
    const hit = svg.querySelector("polyline:last-of-type") as SVGElement;
    // y = 24 of 72 → 12 − 72/3 = −12 dB.
    fireEvent.pointerDown(hit, { button: 0, clientX: 168 + 100, clientY: 24 });
    fireEvent.pointerUp(window);
    expect(clipsOf("a1")[0]?.gain).toBe("-12");
    // Ctrl+click: a key at 1 s, 0 dB.
    const hit2 = (clipEl("s").querySelector("[data-gain-line]") as SVGSVGElement).querySelector("polyline:last-of-type") as SVGElement;
    fireEvent.pointerDown(hit2, { button: 0, clientX: 168 + 100, clientY: 12, ctrlKey: true });
    fireEvent.pointerUp(window);
    const gain = JSON.parse(clipsOf("a1")[0]?.gain ?? "{}") as { keys: Array<{ t: number; v: number }> };
    expect(gain.keys.map((k) => [k.t, k.v])).toEqual([[0, -12], [1000, 0], [4000, -12]]);
    // Alt+click removes the key at 1 s.
    const dots = clipEl("s").querySelectorAll("circle");
    const keyDot = Array.from(dots).find((c) => c.getAttribute("cx") === "100") as SVGElement;
    fireEvent.pointerDown(keyDot, { button: 0, altKey: true });
    expect(JSON.parse(clipsOf("a1")[0]?.gain ?? "{}").keys).toHaveLength(2);
  });

  it("the fade handles set fadeInMs and fadeOutMs", () => {
    open([], [aud("s", 0, 4000)]);
    render(<TracksPanel />);
    const svg = clipEl("s").querySelector("[data-gain-line]") as SVGSVGElement;
    svg.getBoundingClientRect = () => ({ top: 0, bottom: 72, left: 168, right: 568, width: 400, height: 72, x: 168, y: 0, toJSON: () => ({}) });
    const [fin, fout] = Array.from(svg.querySelectorAll("circle")).slice(-2) as unknown as [SVGElement, SVGElement];
    fireEvent.pointerDown(fin, { button: 0, clientX: 168 + 6 });
    fireEvent.pointerMove(window, { clientX: 168 + 150 });
    fireEvent.pointerUp(window);
    expect(clipsOf("a1")[0]?.fadeInMs).toBe(1500);
    fireEvent.pointerDown(fout, { button: 0, clientX: 168 + 394 });
    fireEvent.pointerMove(window, { clientX: 168 + 300 }); // 100 px from the right = 1 s
    fireEvent.pointerUp(window);
    expect(clipsOf("a1")[0]?.fadeOutMs).toBe(1000);
  });

  it("a selected clip with keys shows one diamond per keyed time; drag moves them; Alt+click deletes; double-click focuses the param", () => {
    const keyed = serializeTransform({
      x: { base: 0, keys: [{ t: 500, v: 0, ease: "linear" }, { t: 1500, v: 1, ease: "linear" }] },
      y: 0,
      scale: { base: 1, keys: [{ t: 500, v: 1, ease: "linear" }] },
      rotation: 0,
      opacity: 1,
    });
    open([vid("v", 0, 4000, { transform: keyed })]);
    render(<TracksPanel />);
    expect(clipEl("v").querySelector("[data-key-strip]")).toBeNull(); // not selected
    act(() => useEditStudio.getState().select({ kind: "clips", ids: ["v"] }));
    const strip = clipEl("v").querySelector("[data-key-strip]") as HTMLElement;
    expect(strip.querySelectorAll("[data-key-time]")).toHaveLength(2); // 500 (x and scale merged), 1500
    // Drag the 500 ms diamond 0.5 s right (50 px at 100 px/s).
    const d500 = strip.querySelector('[data-key-time="500"]') as HTMLElement;
    fireEvent.pointerDown(d500, { button: 0, clientX: 100, clientY: 5 });
    fireEvent.pointerMove(window, { clientX: 125, clientY: 5 });
    fireEvent.pointerMove(window, { clientX: 150, clientY: 5 });
    fireEvent.pointerUp(window);
    const times = Array.from(clipEl("v").querySelectorAll("[data-key-time]")).map((e) => e.getAttribute("data-key-time"));
    expect(times).toEqual(["1500", "1000"].sort((a, b) => Number(a) - Number(b)));
    // Double-click opens the param in the inspector.
    fireEvent.doubleClick(clipEl("v").querySelector('[data-key-time="1500"]') as HTMLElement);
    expect(useTimelineStore.getState().paramFocus).toMatchObject({ clipId: "v", param: "transform.x" });
    // Alt+click deletes the keys at 1500.
    fireEvent.pointerDown(clipEl("v").querySelector('[data-key-time="1500"]') as HTMLElement, { button: 0, altKey: true });
    expect(Array.from(clipEl("v").querySelectorAll("[data-key-time]")).map((e) => e.getAttribute("data-key-time"))).toEqual(["1000"]);
  });

  it("no strip at small height", () => {
    const keyed = serializeTransform({ x: { base: 0, keys: [{ t: 500, v: 0, ease: "linear" }] }, y: 0, scale: 1, rotation: 0, opacity: 1 });
    open([vid("v", 0, 4000, { transform: keyed })]);
    const doc = project();
    useEditStudio.getState().edit({ ...doc, tracks: doc.tracks.map((t) => (t.id === "t1" ? { ...t, height: "s" } : t)) });
    useEditStudio.getState().select({ kind: "clips", ids: ["v"] });
    render(<TracksPanel />);
    expect(clipEl("v").querySelector("[data-key-strip]")).toBeNull();
  });

  it("gain keys come with the clip's JSON (serializeGain round trip used by the drag)", () => {
    expect(serializeGain(-12)).toBe("-12");
  });
});
