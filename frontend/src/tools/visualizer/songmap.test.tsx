import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFixture } from "@/viz/fixture";
import { SongMap } from "./SongMap";
import { blockIndexAt, clampPxPerSec, rulerStepSec, scrollForAnchor, sectionBlocks, selectionFromDrag, timeAtX, visibleLanes } from "./songmap/model";

const calls: string[] = [];
const ctxStub = new Proxy(
  {},
  {
    get: (_t, p: string) => {
      if (p === "measureText") return (s: string) => ({ width: s.length * 6 });
      return (...a: unknown[]) => {
        if (p === "fillText") calls.push(String(a[0]));
      };
    },
    set: () => true,
  },
);

beforeEach(() => {
  calls.length = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ctxStub) as never);
});
afterEach(() => vi.restoreAllMocks());

describe("song map model", () => {
  it("hides lanes without data", () => {
    expect(visibleLanes(buildFixture())).toEqual(["sections", "beats", "drums", "bass", "vocals", "other", "chords", "mood", "lyrics"]);
    expect(visibleLanes(buildFixture({ words: false }))).not.toContain("lyrics");
    const noStems = visibleLanes(buildFixture({ stems: false, words: false }));
    expect(noStems).toEqual(["sections", "beats", "chords"]);
    expect(visibleLanes(buildFixture(), ["beats", "mood"])).toEqual(["beats", "mood"]);
  });
  it("zoom and time maths", () => {
    expect(clampPxPerSec(1, 800, 60000)).toBeCloseTo(800 / 60);
    expect(clampPxPerSec(9999, 800, 60000)).toBe(400);
    expect(timeAtX(100, 200, 100, 60000)).toBe(3000);
    expect(scrollForAnchor(10000, 50, 100, 800, 60000)).toBe(950);
    expect(scrollForAnchor(0, 50, 100, 800, 60000)).toBe(0);
    expect(rulerStepSec(13)).toBe(5);
  });
  it("selection and blocks", () => {
    expect(selectionFromDrag(5000, 1000)).toEqual({ startMs: 1000, endMs: 5000 });
    expect(selectionFromDrag(1000, 1020)).toBeNull();
    const a = buildFixture();
    const blocks = sectionBlocks(a);
    expect(blocks.map((b) => b.label)).toEqual(["intro", "verse", "chorus", "drop", "outro"]);
    expect(blockIndexAt(blocks, (blocks[2]?.startMs ?? 0) + 10)).toBe(2);
  });
});

describe("SongMap", () => {
  const a = buildFixture();
  // Unmeasured jsdom: the view is 800px wide, so 60 s fits at 13.33 px/s.
  const stage = () => screen.getByTestId("songmap-stage");

  it("renders a canvas per lane with labels and draws the section names", () => {
    render(<SongMap analysis={a} playheadMs={0} onSeek={() => undefined} />);
    for (const name of ["Sections", "Beats", "Drums", "Bass", "Vocals", "Other", "Chords", "Mood", "Lyrics"]) {
      expect(screen.getByRole("img", { name: `${name} lane` })).toBeTruthy();
    }
    expect(calls).toContain("chorus");
    expect(calls).toContain("Am");
  });

  it("omits lanes that have no data", () => {
    render(<SongMap analysis={buildFixture({ stems: false, words: false })} playheadMs={0} onSeek={() => undefined} />);
    expect(screen.queryByRole("img", { name: "Drums lane" })).toBeNull();
    expect(screen.queryByRole("img", { name: "Lyrics lane" })).toBeNull();
    expect(screen.getByRole("img", { name: "Chords lane" })).toBeTruthy();
  });

  it("moves the playhead without redrawing the canvases", () => {
    const { rerender } = render(<SongMap analysis={a} playheadMs={0} onSeek={() => undefined} />);
    const n = calls.length;
    rerender(<SongMap analysis={a} playheadMs={30000} onSeek={() => undefined} />);
    expect(calls.length).toBe(n);
    expect(screen.getByTestId("songmap-playhead").getAttribute("data-ms")).toBe("30000");
  });

  it("seeks on click", () => {
    const onSeek = vi.fn();
    render(<SongMap analysis={a} playheadMs={0} onSeek={onSeek} />);
    fireEvent.mouseDown(stage(), { clientX: 400, clientY: 5, button: 0 });
    fireEvent.mouseUp(window, { clientX: 400 });
    expect(onSeek).toHaveBeenCalledWith(30000);
  });

  it("shift-drag selects a range", () => {
    const onSelect = vi.fn();
    render(<SongMap analysis={a} playheadMs={0} onSeek={() => undefined} onSelect={onSelect} />);
    fireEvent.mouseDown(stage(), { clientX: 200, clientY: 5, button: 0, shiftKey: true });
    fireEvent.mouseMove(window, { clientX: 400 });
    expect(screen.getByTestId("songmap-selection")).toBeTruthy();
    fireEvent.mouseUp(window, { clientX: 400 });
    expect(onSelect).toHaveBeenCalledWith({ startMs: 15000, endMs: 30000 });
  });

  it("calls onSectionClick for a section block and from the accessible list", () => {
    const onSectionClick = vi.fn();
    const onSeek = vi.fn();
    render(<SongMap analysis={a} playheadMs={0} onSeek={onSeek} onSectionClick={onSectionClick} />);
    // The sections lane is the first lane below the 16px ruler; x = 50 -> 3.75 s -> intro.
    fireEvent.mouseDown(stage(), { clientX: 50, clientY: 20, button: 0 });
    fireEvent.mouseUp(window);
    expect(onSectionClick).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByRole("button", { name: /^chorus/ }));
    expect(onSectionClick).toHaveBeenLastCalledWith(2);
  });

  it("zooms with Ctrl+wheel and fits again", () => {
    render(<SongMap analysis={a} playheadMs={0} onSeek={() => undefined} />);
    const slider = screen.getByRole("slider", { name: "Song position" });
    const fit = screen.getByRole("button", { name: "Fit the whole song" }) as HTMLButtonElement;
    expect(fit.disabled).toBe(true);
    fireEvent.wheel(slider, { ctrlKey: true, deltaY: -200, clientX: 100 });
    expect((screen.getByRole("button", { name: "Fit the whole song" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Fit the whole song" }));
    expect((screen.getByRole("button", { name: "Fit the whole song" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("seeks with the keyboard", () => {
    const onSeek = vi.fn();
    render(<SongMap analysis={a} playheadMs={10000} onSeek={onSeek} />);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Song position" }), { key: "ArrowRight" });
    expect(onSeek).toHaveBeenCalledWith(11000);
  });
});
