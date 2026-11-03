import { describe, expect, it } from "vitest";
import type { EditMatte, EditMatteClick, EditMatteState } from "@/lib/api";
import {
  clicksFor,
  covers,
  describeEstimate,
  estimateSeconds,
  frameOfMs,
  hasPositive,
  makeMatte,
  matteStatus,
  modesFor,
  sameClicks,
  sampledFrames,
  snapMs,
} from "./matteUtil";

const click = (ms: number, positive = true, x = 0.5, y = 0.5): EditMatteClick => ({ ms, x, y, positive });
const matte = (over: Partial<EditMatte> = {}): EditMatte => ({
  mode: "people",
  id: "m1",
  fromMs: 0,
  toMs: 0,
  clicks: [],
  cutout: true,
  invert: false,
  feather: 0,
  stroke: { px: 0, color: "#ffffff" },
  glow: { amount: 0, color: "#ffffff" },
  ...over,
});
const state = (over: Partial<EditMatteState> = {}): EditMatteState => ({ id: "m1", ready: true, fromMs: 500, toMs: 9500, preview: null, export: null, image: "", ...over });

describe("modesFor", () => {
  it("offers photos Photo and videos People or Select", () => {
    expect(modesFor("image")).toEqual(["image"]);
    expect(modesFor("video")).toEqual(["people", "select"]);
    expect(modesFor("color")).toEqual([]);
    expect(modesFor("adjust")).toEqual([]);
  });
});

describe("matteStatus", () => {
  const span = { fromMs: 1000, toMs: 9000 };
  it.each([
    ["no matte", null, undefined, "none", "none"],
    ["a running job wins", matte(), state(), "active", "making"],
    ["a failed job", matte(), state(), "failed", "failed"],
    ["no files", matte(), undefined, "none", "missing"],
    ["files not ready", matte(), state({ ready: false }), "none", "missing"],
    ["covered", matte(), state(), "none", "ready"],
    ["exactly covered", matte(), state({ fromMs: 1000, toMs: 9000 }), "none", "ready"],
    ["starts before the matte", matte(), state({ fromMs: 1500 }), "none", "stale"],
    ["ends after the matte", matte(), state({ toMs: 8900 }), "none", "stale"],
    ["a frame of rounding is fine", matte(), state({ toMs: 8990 }), "none", "ready"],
    ["photos have no range", matte({ mode: "image" }), state({ fromMs: 0, toMs: 0, image: "/a.png" }), "none", "ready"],
  ] as const)("%s", (_n, m, s, job, want) => {
    expect(matteStatus(m, s, span, job)).toBe(want);
  });

  it("covers is inclusive, with a frame of slack", () => {
    expect(covers({ fromMs: 0, toMs: 10 }, { fromMs: 0, toMs: 10 })).toBe(true);
    expect(covers({ fromMs: 30, toMs: 1000 }, { fromMs: 0, toMs: 1000 })).toBe(true);
    expect(covers({ fromMs: 100, toMs: 1000 }, { fromMs: 0, toMs: 1000 })).toBe(false);
    expect(covers({ fromMs: 0, toMs: 1000 }, { fromMs: 0, toMs: 1100 })).toBe(false);
  });
});

describe("clicks", () => {
  it("snaps to frames", () => {
    expect(snapMs(1017, 30)).toBe(1033);
    expect(snapMs(1000, 30)).toBe(1000);
    expect(frameOfMs(snapMs(2345, 60), 60)).toBe(frameOfMs(2345, 60));
  });

  it("puts the clicks of the shown frame first and keeps the rest in order", () => {
    const cs = [click(0), click(1000), click(2000), click(1000, false)];
    expect(clicksFor(cs, 1000, 30).map((c) => [c.ms, c.positive])).toEqual([
      [1000, true],
      [1000, false],
      [0, true],
      [2000, true],
    ]);
    expect(clicksFor(cs, 5000, 30)).toEqual(cs);
  });

  it("needs a positive point; compares lists", () => {
    expect(hasPositive([click(0, false)])).toBe(false);
    expect(hasPositive([click(0, false), click(1)])).toBe(true);
    expect(sameClicks([click(0)], [click(0)])).toBe(true);
    expect(sameClicks([click(0)], [click(0, false)])).toBe(false);
    expect(sameClicks([click(0)], [])).toBe(false);
  });
});

describe("estimate", () => {
  it("counts sampled frames at ≤ 15 per second, with the padding and the last frame", () => {
    expect(sampledFrames(10_000, 30)).toBe(Math.ceil(Math.round(11 * 30) / 2) + 1);
    expect(sampledFrames(10_000, 60)).toBe(Math.ceil(Math.round(11 * 60) / 4) + 1);
    expect(sampledFrames(10_000, 15)).toBe(Math.round(11 * 15) + 1);
  });

  it("is about 2 s per sampled frame, phrased in minutes", () => {
    expect(estimateSeconds(10_000, 30)).toBe(sampledFrames(10_000, 30) * 2);
    expect(describeEstimate(20)).toBe("under a minute");
    expect(describeEstimate(60)).toBe("about a minute");
    expect(describeEstimate(190)).toBe("about 3 minutes");
    expect(describeEstimate(estimateSeconds(60_000, 30))).toBe("about 31 minutes");
  });
});

describe("makeMatte", () => {
  it("keeps the look of the previous matte and drops clicks outside select", () => {
    const prev = matte({ cutout: false, invert: true, feather: 0.4, stroke: { px: 6, color: "#ff0000" }, glow: { amount: 0.5, color: "#00ff00" } });
    const next = makeMatte("people", "m2", { fromMs: 100, toMs: 900 }, [click(1)], prev);
    expect(next).toMatchObject({ mode: "people", id: "m2", fromMs: 100, toMs: 900, clicks: [], cutout: false, invert: true, feather: 0.4, stroke: { px: 6 } });
    expect(makeMatte("select", "m3", { fromMs: 0, toMs: 5 }, [click(1)], null)).toMatchObject({ clicks: [click(1)], cutout: true, stroke: { px: 0 } });
    expect(makeMatte("image", "m4", { fromMs: 9, toMs: 99 }, [], null)).toMatchObject({ fromMs: 0, toMs: 0 });
  });
});
