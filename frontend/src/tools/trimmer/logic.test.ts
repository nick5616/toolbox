import { describe, expect, it } from "vitest";
import { TrimAspect, TrimJoin, TrimMode } from "@/lib/api";
import {
  DEFAULT_SETTINGS,
  addSegment,
  applyRanges,
  aspectRatio,
  buildOptions,
  estimateBytes,
  keyframeAtOrBefore,
  keyframeNote,
  keyframeShiftMs,
  needsPrecise,
  sanitizeSettings,
  segmentsError,
  setEnd,
  setStart,
  sourceAspect,
  summaryText,
  type Seg,
} from "./logic";

const seg = (id: string, startMs: number, endMs: number): Seg => ({ id, startMs, endMs });
const MB = 1024 * 1024;

describe("sanitizeSettings", () => {
  it("keeps valid values and drops bad ones", () => {
    expect(sanitizeSettings({ mode: "precise", join: "separate", aspect: "9:16", cropX: 0.2, maxSizeMB: 25, maxHeight: 720, removeAudio: true }, DEFAULT_SETTINGS)).toMatchObject({
      mode: "precise",
      join: "separate",
      aspect: "9:16",
      cropX: 0.2,
      maxSizeMB: 25,
      maxHeight: 720,
      removeAudio: true,
    });
    expect(sanitizeSettings({ mode: "x", cropX: 4, maxSizeMB: -1, maxHeight: 999 }, DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(null, DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it("forces precise when saved re-encode options need it", () => {
    expect(sanitizeSettings({ mode: "fast", aspect: "1:1" }, DEFAULT_SETTINGS).mode).toBe(TrimMode.ModePrecise);
  });
});

describe("helpers", () => {
  it("needsPrecise / aspectRatio / sourceAspect", () => {
    expect(needsPrecise(DEFAULT_SETTINGS)).toBe(false);
    expect(needsPrecise({ ...DEFAULT_SETTINGS, maxHeight: 720 })).toBe(true);
    expect(aspectRatio(TrimAspect.AspectPortrait)).toBeCloseTo(9 / 16);
    expect(aspectRatio(TrimAspect.AspectKeep)).toBeNull();
    const video = (w: number, h: number, rotation: number) => ({ video: { width: w, height: h, rotation } }) as never;
    expect(sourceAspect(video(1920, 1080, 0))).toBeCloseTo(16 / 9);
    expect(sourceAspect(video(1920, 1080, 90))).toBeCloseTo(9 / 16);
    expect(sourceAspect({ video: null } as never)).toBeNull();
  });
});

describe("segment editing", () => {
  const two = [seg("a", 0, 4000), seg("b", 6000, 9000)];

  it("setStart stays inside its neighbours", () => {
    expect(setStart(two, "b", 3000)[1]?.startMs).toBe(4000);
    expect(setStart(two, "b", 8950)[1]?.startMs).toBe(8900);
    expect(setStart(two, "b", 7000)[1]?.startMs).toBe(7000);
  });

  it("setEnd stays inside its neighbours", () => {
    expect(setEnd(two, "a", 7000, 10000)[0]?.endMs).toBe(6000);
    expect(setEnd(two, "a", 10, 10000)[0]?.endMs).toBe(100);
    expect(setEnd(two, "b", 99999, 10000)[1]?.endMs).toBe(10000);
  });

  it("addSegment makes a 5 s segment at the playhead, capped by the next one", () => {
    const r = addSegment([seg("a", 0, 1000), seg("b", 8000, 9000)], 2000, 20000);
    expect(r?.segs.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 1000],
      [2000, 7000],
      [8000, 9000],
    ]);
    expect(addSegment([seg("a", 0, 1000)], 500, 20000)?.segs[1]).toMatchObject({ startMs: 1000, endMs: 6000 });
    expect(addSegment([seg("a", 0, 1000)], 19000, 20000)?.segs[1]).toMatchObject({ startMs: 19000, endMs: 20000 });
  });

  it("addSegment falls back to a gap, or refuses when full", () => {
    const r = addSegment([seg("a", 1000, 10000)], 9500, 10000);
    expect(r?.segs[0]).toMatchObject({ startMs: 0, endMs: 1000 });
    expect(addSegment([seg("a", 0, 10000)], 5000, 10000)).toBeNull();
    const many = Array.from({ length: 50 }, (_, i) => seg(`s${i}`, i * 100, i * 100 + 50));
    expect(addSegment(many, 9000, 20000)).toBeNull();
  });

  it("applyRanges rejects overlap and too-short results", () => {
    const base = [seg("a", 0, 4000), seg("b", 6000, 9000)];
    const ok = applyRanges(base, [{ id: "a", startMs: 0, endMs: 5000 }]);
    expect(ok[0]?.endMs).toBe(5000);
    expect(applyRanges(base, [{ id: "a", startMs: 0, endMs: 7000 }])).toBe(base);
    expect(applyRanges(base, [{ id: "a", startMs: 3950, endMs: 4000 }])).toBe(base);
  });

  it("segmentsError", () => {
    expect(segmentsError([], 1000)).toMatch(/Add a segment/);
    expect(segmentsError([seg("a", 0, 50)], 1000)).toMatch(/0.1 s/);
    expect(segmentsError([seg("a", 0, 2000)], 1000)).toMatch(/outside/);
    expect(segmentsError([seg("a", 0, 1000)], 1000)).toBeNull();
  });
});

describe("keyframes", () => {
  const kf = [0, 1500, 3000, 6000];
  it("finds the keyframe at or before", () => {
    expect(keyframeAtOrBefore(kf, 3000)).toBe(3000);
    expect(keyframeAtOrBefore(kf, 4400)).toBe(3000);
    expect(keyframeAtOrBefore(kf, -5)).toBeUndefined();
  });
  it("reports the shift only when noticeable", () => {
    expect(keyframeShiftMs(kf, 4400)).toBe(1400);
    expect(keyframeShiftMs(kf, 3050)).toBe(0);
    expect(keyframeShiftMs(undefined, 4400)).toBe(0);
    expect(keyframeNote(1400)).toBe("starts 1.4 s earlier (keyframe)");
  });
});

describe("estimate and summary", () => {
  const fast = { mode: TrimMode.ModeFast, maxSizeMB: 0 };
  it("fast scales the source by the kept fraction", () => {
    expect(estimateBytes(fast, 100 * MB, 100_000, 25_000)).toBe(25 * MB);
  });
  it("precise uses the limit or says it depends", () => {
    expect(estimateBytes({ mode: TrimMode.ModePrecise, maxSizeMB: 25 }, 100 * MB, 100_000, 25_000)).toBe(25 * MB);
    expect(estimateBytes({ mode: TrimMode.ModePrecise, maxSizeMB: 0 }, 100 * MB, 100_000, 25_000)).toBeNull();
  });
  it("summary text", () => {
    const segs = [seg("a", 0, 40_000), seg("b", 50_000, 93_000)];
    expect(summaryText(segs, fast, 100 * MB, 100_000)).toBe("2 segments · 1:23 total · ≈ 83 MB");
    expect(summaryText([seg("a", 0, 1000)], { mode: TrimMode.ModePrecise, maxSizeMB: 0 }, MB, 1000)).toBe("1 segment · 0:01 total · size depends on the content");
  });
});

describe("buildOptions", () => {
  it("sorts, clamps, and normalises join/aspect", () => {
    const o = buildOptions([seg("b", 6000, 12000), seg("a", 0, 4000)], { ...DEFAULT_SETTINGS, join: TrimJoin.JoinSeparate, aspect: TrimAspect.AspectSquare }, false, 10000);
    expect(o.segments).toEqual([
      { startMs: 0, endMs: 4000 },
      { startMs: 6000, endMs: 10000 },
    ]);
    expect(o.join).toBe(TrimJoin.JoinSeparate);
    expect(o.aspect).toBe(TrimAspect.AspectKeep);
    expect(buildOptions([seg("a", 0, 1000)], { ...DEFAULT_SETTINGS, join: TrimJoin.JoinSeparate }, true, 1000).join).toBe(TrimJoin.JoinMerge);
  });
});
