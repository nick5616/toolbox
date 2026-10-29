import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MediaSource } from "@/lib/api";
import { BoxOverlay } from "./BoxOverlay";
import { CropOverlay } from "./CropOverlay";
import { MediaPlayer } from "./MediaPlayer";
import { Timeline } from "./Timeline";
import type { Box, MediaPlayerHandle, Range } from "./types";

const info = {
  durationMs: 10_000, startMs: 2000, container: "mp4", sizeBytes: 1, bitRate: 0,
  video: { index: 0, codec: "h264", width: 1920, height: 1080, fps: 25, rotation: 0, pixFmt: "yuv420p" },
  audio: null, subtitles: null, hasCover: false, tags: null,
} as MediaSource["info"];
const source: MediaSource = { url: "/media/t/a.mp4", info, proxy: false, proxyJobId: "" };

// jsdom has no layout: give elements a size.
function mockRect(el: Element, w: number, h: number) {
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON: () => ({}) });
}

describe("MediaPlayer", () => {
  function setup(props: Partial<React.ComponentProps<typeof MediaPlayer>> = {}) {
    const ref = createRef<MediaPlayerHandle>();
    const onTime = vi.fn();
    const utils = render(<MediaPlayer ref={ref} source={source} kind="video" onTime={onTime} {...props} />);
    const video = utils.container.querySelector("video") as HTMLVideoElement;
    // readyState is read-only in jsdom.
    Object.defineProperty(video, "readyState", { value: 4, configurable: true });
    video.play = vi.fn(() => Promise.resolve());
    video.pause = vi.fn();
    return { ref, onTime, video, ...utils };
  }

  it("seeks adding startMs and reports time minus startMs", () => {
    const { ref, video, onTime } = setup();
    ref.current?.seek(3000);
    expect(video.currentTime).toBeCloseTo(5);
    expect(onTime).toHaveBeenLastCalledWith(3000);
    expect(ref.current?.currentMs()).toBeCloseTo(3000);
  });

  it("clamps seeks to the duration", () => {
    const { ref, video } = setup();
    ref.current?.seek(99_000);
    expect(video.currentTime).toBeCloseTo(12);
  });

  it("steps by the video's frame time and pauses", () => {
    const { ref, video } = setup();
    ref.current?.seek(1000);
    ref.current?.step(1);
    expect(video.currentTime).toBeCloseTo(3.04);
    expect(video.pause).toHaveBeenCalled();
  });

  it("handles keys but not inside text inputs", () => {
    const { ref, video } = setup();
    ref.current?.seek(1000);
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(video.currentTime).toBeCloseTo(8);
    fireEvent.keyDown(document.body, { key: "End" });
    expect(video.currentTime).toBeCloseTo(12);
    fireEvent.keyDown(document.body, { key: "Home" });
    expect(video.currentTime).toBeCloseTo(2);
    fireEvent.keyDown(document.body, { key: " " });
    expect(video.play).toHaveBeenCalledTimes(1);

    const input = screen.getByLabelText("Current time");
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(video.currentTime).toBeCloseTo(2);
  });

  it("ignores keys when keyboard is off", () => {
    const { video } = setup({ keyboard: false });
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(video.currentTime).toBe(0);
  });

  it("seeks from a typed timecode", () => {
    const { video } = setup();
    const input = screen.getByLabelText("Current time");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "0:04.5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(video.currentTime).toBeCloseTo(6.5);
  });

  it("passes the letterboxed rect to the overlay", () => {
    const seen: Array<{ left: number; top: number; width: number; height: number }> = [];
    const { container } = setup({ overlay: (r) => { seen.push(r); return <i data-testid="ov" />; } });
    // Without layout the rect is zero, so no overlay yet.
    expect(container.querySelector('[data-testid="ov"]')).toBeNull();
    expect(seen).toHaveLength(0);
  });
});

describe("Timeline", () => {
  // jsdom has no layout: make every element 1000 px wide so the track width is known.
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  beforeAll(() => Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 }));
  afterAll(() => {
    if (desc) Object.defineProperty(HTMLElement.prototype, "clientWidth", desc);
    else Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  });
  const ranges: Range[] = [{ id: "r1", startMs: 2000, endMs: 6000, label: "Clip" }];
  function setup(extra: Partial<React.ComponentProps<typeof Timeline>> = {}) {
    const onRangesChange = vi.fn();
    const onSeek = vi.fn();
    const utils = render(
      <Timeline durationMs={10_000} playheadMs={4000} onSeek={onSeek} ranges={ranges} onRangesChange={onRangesChange} frameMs={40} zoomable {...extra} />,
    );
    return { onRangesChange, onSeek, ...utils };
  }

  it("moves handles with the arrow keys (frame, 1 s with Shift)", () => {
    const { onRangesChange } = setup();
    const start = screen.getByRole("slider", { name: "Start of Clip" });
    fireEvent.keyDown(start, { key: "ArrowRight" });
    expect(onRangesChange).toHaveBeenLastCalledWith([{ id: "r1", startMs: 2040, endMs: 6000, label: "Clip" }]);
    fireEvent.keyDown(screen.getByRole("slider", { name: "End of Clip" }), { key: "ArrowLeft", shiftKey: true });
    expect(onRangesChange).toHaveBeenLastCalledWith([{ id: "r1", startMs: 2000, endMs: 5000, label: "Clip" }]);
  });

  it("does not let the player's key handler act on handle keys", () => {
    const { container } = render(<MediaPlayer source={source} kind="video" />);
    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "readyState", { value: 4, configurable: true });
    setup();
    fireEvent.keyDown(screen.getByRole("slider", { name: "Start of Clip" }), { key: "ArrowRight" });
    expect(video.currentTime).toBe(0);
  });

  it("drags an edge and snaps to the playhead within 6px", () => {
    const { onRangesChange, container } = setup();
    const track = container.querySelector('[data-testid="timeline"] > div:nth-child(2)') as HTMLElement;
    mockRect(track, 1000, 56);
    const end = screen.getByRole("slider", { name: "End of Clip" });
    fireEvent.pointerDown(end, { button: 0, pointerId: 1, clientX: 600 });
    // 10 s over 1000 px = 10 ms/px; the playhead (4000 ms) sits at 400 px.
    fireEvent.pointerMove(track, { pointerId: 1, clientX: 405 });
    expect((onRangesChange.mock.calls.at(-1)?.[0] as Range[])[0]?.endMs).toBe(4000);
    fireEvent.pointerMove(track, { pointerId: 1, clientX: 420 });
    expect((onRangesChange.mock.calls.at(-1)?.[0] as Range[])[0]?.endMs).toBe(4200);
    fireEvent.pointerMove(track, { pointerId: 1, clientX: 405, altKey: true });
    expect((onRangesChange.mock.calls.at(-1)?.[0] as Range[])[0]?.endMs).toBe(4050);
    fireEvent.pointerUp(track, { pointerId: 1 });
    onRangesChange.mockClear();
    fireEvent.pointerMove(track, { pointerId: 1, clientX: 500 });
    expect(onRangesChange).not.toHaveBeenCalled();
  });

  it("seeks on click", () => {
    const { onSeek, container } = setup();
    const track = container.querySelector('[data-testid="timeline"] > div:nth-child(2)') as HTMLElement;
    mockRect(track, 1000, 56);
    fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientX: 250 });
    expect(onSeek).toHaveBeenCalledWith(2500);
  });

  it("renders markers and reports clicks", () => {
    const onMarkerClick = vi.fn();
    setup({ markers: [{ id: "m1", startMs: 1000, label: "Cue 1" }], onMarkerClick });
    fireEvent.click(screen.getByRole("button", { name: "Cue 1" }));
    expect(onMarkerClick).toHaveBeenCalledWith("m1");
  });
});

describe("BoxOverlay", () => {
  const rect = { left: 0, top: 0, width: 400, height: 200 };
  const boxes: Box[] = [
    { id: "f1", x: 0.1, y: 0.1, w: 0.2, h: 0.3, kind: "face", enabled: true },
    { id: "m1", x: 0.5, y: 0.5, w: 0.2, h: 0.2, kind: "manual", enabled: false },
  ];

  it("toggles enabled on click and selects", () => {
    const onChange = vi.fn();
    const onSelect = vi.fn();
    render(<BoxOverlay rect={rect} boxes={boxes} editable onChange={onChange} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("box-f1"));
    expect(onSelect).toHaveBeenCalledWith("f1");
    expect(onChange.mock.calls[0]?.[0]).toMatchObject([{ id: "f1", enabled: false }, { id: "m1", enabled: false }]);
  });

  it("does nothing when not editable", () => {
    const onChange = vi.fn();
    render(<BoxOverlay rect={rect} boxes={boxes} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("box-f1"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("draws a manual box in drawMode", () => {
    const onChange = vi.fn();
    render(<BoxOverlay rect={rect} boxes={[]} editable drawMode onChange={onChange} />);
    const root = screen.getByTestId("box-overlay");
    mockRect(root, 400, 200);
    fireEvent.pointerDown(root, { button: 0, pointerId: 1, clientX: 40, clientY: 20 });
    fireEvent.pointerMove(root, { pointerId: 1, clientX: 200, clientY: 100 });
    fireEvent.pointerUp(root, { pointerId: 1, clientX: 200, clientY: 100 });
    const out = onChange.mock.calls[0]?.[0] as Box[];
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "manual", enabled: true, x: 0.1, y: 0.1, w: 0.4, h: 0.4 });
  });

  it("ignores tiny drags", () => {
    const onChange = vi.fn();
    render(<BoxOverlay rect={rect} boxes={[]} editable drawMode onChange={onChange} />);
    const root = screen.getByTestId("box-overlay");
    mockRect(root, 400, 200);
    fireEvent.pointerDown(root, { button: 0, pointerId: 1, clientX: 40, clientY: 20 });
    fireEvent.pointerUp(root, { pointerId: 1, clientX: 41, clientY: 20 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("resizes with a corner handle", () => {
    const onChange = vi.fn();
    render(<BoxOverlay rect={rect} boxes={boxes} editable selectedId="m1" onSelect={() => {}} onChange={onChange} />);
    const root = screen.getByTestId("box-overlay");
    mockRect(root, 400, 200);
    fireEvent.pointerDown(screen.getByTestId("handle-m1-se"), { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(root, { pointerId: 2, clientX: 360, clientY: 160 });
    const out = onChange.mock.calls.at(-1)?.[0] as Box[];
    expect(out[1]).toMatchObject({ x: 0.5, y: 0.5, w: expect.closeTo(0.4) as number, h: expect.closeTo(0.3) as number });
  });

  it("deletes a selected manual box but not a detected one", () => {
    const onChange = vi.fn();
    const { rerender } = render(<BoxOverlay rect={rect} boxes={boxes} editable selectedId="m1" onSelect={() => {}} onChange={onChange} />);
    fireEvent.keyDown(screen.getByTestId("box-overlay"), { key: "Delete" });
    expect((onChange.mock.calls[0]?.[0] as Box[]).map((b) => b.id)).toEqual(["f1"]);
    onChange.mockClear();
    rerender(<BoxOverlay rect={rect} boxes={boxes} editable selectedId="f1" onSelect={() => {}} onChange={onChange} />);
    fireEvent.keyDown(screen.getByTestId("box-overlay"), { key: "Delete" });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("CropOverlay", () => {
  it("clamps the window to the picture and nudges with arrows", () => {
    const onChange = vi.fn();
    render(<CropOverlay rect={{ left: 0, top: 0, width: 800, height: 450 }} aspect={9 / 16} sourceAspect={16 / 9} x={0} y={0.5} onChange={onChange} />);
    const win = screen.getByTestId("crop-window");
    const w = (9 / 16) / (16 / 9);
    expect(win.style.left).toBe("0%");
    expect(parseFloat(win.style.width)).toBeCloseTo(w * 100);
    fireEvent.keyDown(win, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith(expect.closeTo(w / 2 + 0.01) as number, 0.5);
    fireEvent.keyDown(win, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(w / 2, 0.5);
  });

  it("drags", () => {
    const onChange = vi.fn();
    const { container } = render(<CropOverlay rect={{ left: 0, top: 0, width: 800, height: 450 }} aspect={9 / 16} sourceAspect={16 / 9} x={0.5} y={0.5} onChange={onChange} />);
    const parent = container.firstElementChild as HTMLElement;
    mockRect(parent, 800, 450);
    const win = screen.getByTestId("crop-window");
    fireEvent.pointerDown(win, { button: 0, pointerId: 1, clientX: 400, clientY: 200 });
    fireEvent.pointerMove(win, { pointerId: 1, clientX: 560, clientY: 200 });
    expect(onChange).toHaveBeenLastCalledWith(expect.closeTo(0.7) as number, 0.5);
    fireEvent.pointerMove(win, { pointerId: 1, clientX: 5000, clientY: 200 });
    const w = (9 / 16) / (16 / 9);
    expect(onChange).toHaveBeenLastCalledWith(expect.closeTo(1 - w / 2) as number, 0.5);
  });
});
