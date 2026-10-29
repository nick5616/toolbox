import { describe, expect, it } from "vitest";
import {
  clampCropCenter,
  clampView,
  computeContentRect,
  cropWindow,
  formatMs,
  moveRangeEdge,
  nudgeRangeEdge,
  panView,
  parseTimecodeMs,
  playerKeyAction,
  resizeBox,
  rulerStep,
  snapToPlayhead,
  zoomView,
} from "./logic";
import type { Box, Range } from "./types";

describe("computeContentRect", () => {
  it("letterboxes a wide picture in a tall box", () => {
    expect(computeContentRect(800, 600, 1600, 900)).toEqual({ left: 0, top: 75, width: 800, height: 450 });
  });
  it("pillarboxes a tall picture in a wide box", () => {
    expect(computeContentRect(800, 400, 900, 1600)).toEqual({ left: (800 - 225) / 2, top: 0, width: 225, height: 400 });
  });
  it("fills when the aspect matches", () => {
    expect(computeContentRect(640, 360, 1920, 1080)).toEqual({ left: 0, top: 0, width: 640, height: 360 });
  });
  it("falls back to the whole box without a source size and to zero for an empty box", () => {
    expect(computeContentRect(300, 200, 0, 0)).toEqual({ left: 0, top: 0, width: 300, height: 200 });
    expect(computeContentRect(0, 200, 10, 10)).toEqual({ left: 0, top: 0, width: 0, height: 0 });
  });
});

describe("playerKeyAction", () => {
  const cases: Array<[string, Parameters<typeof playerKeyAction>[0], unknown]> = [
    ["space", { key: " " }, { type: "toggle" }],
    ["comma", { key: "," }, { type: "step", frames: -1 }],
    ["period", { key: "." }, { type: "step", frames: 1 }],
    ["shift+comma", { key: "<", shiftKey: true }, { type: "seekBy", ms: -1000 }],
    ["shift+period", { key: ">", shiftKey: true }, { type: "seekBy", ms: 1000 }],
    ["left", { key: "ArrowLeft" }, { type: "seekBy", ms: -5000 }],
    ["right", { key: "ArrowRight" }, { type: "seekBy", ms: 5000 }],
    ["home", { key: "Home" }, { type: "home" }],
    ["end", { key: "End" }, { type: "end" }],
    ["ctrl+space", { key: " ", ctrlKey: true }, null],
    ["letter", { key: "a" }, null],
  ];
  for (const [name, ev, want] of cases) {
    it(name, () => expect(playerKeyAction(ev)).toEqual(want));
  }
});

describe("timecodes", () => {
  it("formats", () => {
    expect(formatMs(0)).toBe("0:00.000");
    expect(formatMs(65_250)).toBe("1:05.250");
    expect(formatMs(3_723_005)).toBe("1:02:03.005");
    expect(formatMs(-5)).toBe("0:00.000");
  });
  it("parses", () => {
    expect(parseTimecodeMs("90")).toBe(90_000);
    expect(parseTimecodeMs("1:05.5")).toBe(65_500);
    expect(parseTimecodeMs("1:02:03.25")).toBe(3_723_250);
    expect(parseTimecodeMs(".5")).toBe(500);
    expect(parseTimecodeMs("abc")).toBeNull();
    expect(parseTimecodeMs("1:2:3:4")).toBeNull();
    expect(parseTimecodeMs("1.5:00")).toBeNull();
    expect(parseTimecodeMs("")).toBeNull();
  });
  it("round-trips", () => {
    expect(parseTimecodeMs(formatMs(123_456))).toBe(123_456);
  });
});

describe("zoom and pan", () => {
  const dur = 100_000;
  it("keeps the anchor time fixed", () => {
    const v = zoomView({ startMs: 0, spanMs: dur }, dur, 0.5, 2);
    expect(v.spanMs).toBe(50_000);
    expect(v.startMs + 0.5 * v.spanMs).toBeCloseTo(50_000);
  });
  it("clamps to the media and to the max zoom", () => {
    expect(zoomView({ startMs: 0, spanMs: dur }, dur, 0, 0.5)).toEqual({ startMs: 0, spanMs: dur });
    expect(zoomView({ startMs: 0, spanMs: dur }, dur, 0.5, 1e9).spanMs).toBe(500);
    expect(clampView({ startMs: 99_000, spanMs: 10_000 }, dur)).toEqual({ startMs: 90_000, spanMs: 10_000 });
  });
  it("pans within bounds", () => {
    expect(panView({ startMs: 10_000, spanMs: 20_000 }, dur, -50_000).startMs).toBe(0);
    expect(panView({ startMs: 10_000, spanMs: 20_000 }, dur, 500_000).startMs).toBe(80_000);
  });
  it("picks ruler steps", () => {
    expect(rulerStep(100_000, 900)).toBe(10_000);
    expect(rulerStep(1_000, 900)).toBe(100);
  });
});

describe("range editing", () => {
  const ranges: Range[] = [
    { id: "a", startMs: 1000, endMs: 5000 },
    { id: "b", startMs: 8000, endMs: 9000 },
  ];
  const o = { durationMs: 10_000, playheadMs: 3000, msPerPx: 10, minMs: 33 };

  it("snaps to the playhead within 6px", () => {
    expect(snapToPlayhead(3050, 3000, 10)).toBe(3000); // 5px
    expect(snapToPlayhead(3060, 3000, 10)).toBe(3000); // 6px
    expect(snapToPlayhead(3070, 3000, 10)).toBe(3070); // 7px
  });
  it("moves an edge and snaps", () => {
    const r = moveRangeEdge(ranges, "a", "end", 3040, o);
    expect(r[0]).toMatchObject({ startMs: 1000, endMs: 3000 });
    expect(r[1]).toBe(ranges[1]);
    expect(moveRangeEdge(ranges, "a", "end", 3040, { ...o, noSnap: true })[0]?.endMs).toBe(3040);
  });
  it("keeps a minimum length and stays inside the media", () => {
    expect(moveRangeEdge(ranges, "a", "start", 9999, { ...o, playheadMs: -1e6 })[0]?.startMs).toBe(5000 - 33);
    expect(moveRangeEdge(ranges, "a", "end", -50, { ...o, playheadMs: -1e6 })[0]?.endMs).toBe(1000 + 33);
    expect(moveRangeEdge(ranges, "b", "end", 50_000, o)[1]?.endMs).toBe(10_000);
    expect(moveRangeEdge(ranges, "a", "start", -50, { ...o, playheadMs: 1e6 })[0]?.startMs).toBe(0);
  });
  it("nudges without snapping", () => {
    const n = { durationMs: 10_000, minMs: 33 };
    expect(nudgeRangeEdge(ranges, "a", "start", 1000, n)[0]?.startMs).toBe(2000);
    expect(nudgeRangeEdge(ranges, "a", "start", -5000, n)[0]?.startMs).toBe(0);
    expect(nudgeRangeEdge(ranges, "zz", "start", 1, n)).toBe(ranges);
  });
});

describe("boxes and crop", () => {
  const box: Box = { id: "m", x: 0.2, y: 0.2, w: 0.4, h: 0.4, kind: "manual", enabled: true };
  it("resizes from the corners without inverting", () => {
    expect(resizeBox(box, "se", 0.8, 0.9)).toMatchObject({ x: 0.2, y: 0.2, w: expect.closeTo(0.6) as number, h: expect.closeTo(0.7) as number });
    expect(resizeBox(box, "nw", 0.0, 0.1)).toMatchObject({ x: 0, y: 0.1 });
    const tiny = resizeBox(box, "se", 0.1, 0.1);
    expect(tiny.w).toBeCloseTo(0.01);
    expect(tiny.h).toBeCloseTo(0.01);
    expect(resizeBox(box, "se", 5, 5)).toMatchObject({ w: expect.closeTo(0.8) as number });
  });
  it("sizes the crop window", () => {
    expect(cropWindow(9 / 16, 16 / 9)).toEqual({ w: (9 / 16) / (16 / 9), h: 1 });
    expect(cropWindow(21 / 9, 16 / 9)).toEqual({ w: 1, h: (16 / 9) / (21 / 9) });
  });
  it("clamps the crop centre", () => {
    const win = { w: 0.3, h: 1 };
    expect(clampCropCenter(0, 0, win)).toEqual({ x: 0.15, y: 0.5 });
    expect(clampCropCenter(1, 1, win)).toEqual({ x: 0.85, y: 0.5 });
    expect(clampCropCenter(0.4, 0.5, win)).toEqual({ x: 0.4, y: 0.5 });
  });
});
