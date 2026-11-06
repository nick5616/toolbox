import { describe, expect, it } from "vitest";
import { D, DAB_STRIDE } from "../engine/gl";
import { RED, line, pt, testBrush } from "../engine/testing";
import { Smoother } from "../input/smoothing";
import { NO_SYMMETRY } from "../guides/symmetry";
import { bakeCurve, evalCurve } from "./curve";
import { StrokeRenderer } from "./engine";
import { createRng, keyedRng } from "./rng";
import type { BrushPreset } from "./schema";

function run(preset: BrushPreset, points = line(10, 50, 110, 50), seed = 7, sym = NO_SYMMETRY) {
  const r = new StrokeRenderer({ preset, color: RED, secondary: RED, seed, symmetry: sym });
  r.begin(points[0]!);
  r.add(points.slice(1));
  r.finish();
  return r;
}

describe("dab spacing", () => {
  it("places dabs every spacing × size along a straight line", () => {
    const r = run(testBrush({ size: 20, spacing: 0.5 }), line(0, 0, 100, 0));
    // 100 px / 10 px = 10 steps → 11 dabs including the first.
    expect(r.dabs.count).toBe(11);
    const xs = Array.from({ length: r.dabs.count }, (_, i) => r.dabs.data[i * DAB_STRIDE + D.X]!);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeCloseTo(10, 3);
  });

  it("emits `count` dabs per step", () => {
    const one = run(testBrush({ spacing: 0.5 }), line(0, 0, 100, 0)).dabs.count;
    const three = run(testBrush({ spacing: 0.5, count: 3 }), line(0, 0, 100, 0)).dabs.count;
    expect(three).toBe(one * 3);
  });
});

describe("dynamics", () => {
  it("monotone curves stay monotone and hit their end points", () => {
    const c: Array<[number, number]> = [
      [0, 0],
      [0.5, 0.9],
      [1, 1],
    ];
    expect(evalCurve(c, 0)).toBe(0);
    expect(evalCurve(c, 1)).toBe(1);
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = evalCurve(c, i / 100);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
    expect(bakeCurve(c).at(0.25)).toBeCloseTo(evalCurve(c, 0.25), 2);
    expect(evalCurve([], 0.3)).toBeCloseTo(0.3);
  });

  it("pressure → size with a curve", () => {
    const preset = testBrush({ size: 40, minSize: 0.1, dynamics: [{ input: "pressure", target: "size", amount: 1, curve: [[0, 0], [1, 1]] }] });
    const pts = [pt(0, 0, 0, 0.1), pt(60, 0, 100, 1)];
    const r = run(preset, pts);
    const first = r.dabs.data[D.SIZE]!;
    const last = r.dabs.data[(r.dabs.count - 1) * DAB_STRIDE + D.SIZE]!;
    expect(first).toBeLessThan(last);
    expect(last).toBeGreaterThan(36);
  });

  it("opacity dynamics scale the dab alpha", () => {
    const preset = testBrush({ dynamics: [{ input: "pressure", target: "opacity", amount: 1, curve: [[0, 0], [1, 1]] }] });
    const r = run(preset, [pt(0, 0, 0, 0.2), pt(60, 0, 100, 0.2)]);
    expect(r.dabs.data[D.ALPHA]).toBeCloseTo(0.2, 1);
  });
});

describe("seeded replay", () => {
  const preset = testBrush({
    scatter: 0.5,
    count: 2,
    tip: { shape: "round", hardness: 0.5, roundness: 0.8, angle: 10, angleMode: "stroke", rotationJitter: 0.7, invert: false },
    color: { hueJitter: 0.3, satJitter: 0.2, briJitter: 0.2, perStroke: false, secondaryMix: 0 },
  });
  it("is identical twice and differs with another seed", () => {
    const a = run(preset, line(0, 0, 80, 40), 99);
    const b = run(preset, line(0, 0, 80, 40), 99);
    const c = run(preset, line(0, 0, 80, 40), 100);
    expect(a.dabs.count).toBe(b.dabs.count);
    expect(Array.from(a.dabs.data.subarray(0, a.dabs.count * DAB_STRIDE))).toEqual(Array.from(b.dabs.data.subarray(0, b.dabs.count * DAB_STRIDE)));
    expect(Array.from(a.dabs.data.subarray(0, 40))).not.toEqual(Array.from(c.dabs.data.subarray(0, 40)));
  });
  it("keyed streams repeat", () => {
    const x = keyedRng(5, "growth");
    const y = keyedRng(5, "growth");
    expect([x(), x(), x()]).toEqual([y(), y(), y()]);
    expect(createRng(1)()).not.toBe(createRng(2)());
  });
});

describe("taper", () => {
  it("end taper shrinks the last dabs", () => {
    const r = run(testBrush({ size: 20, taper: { start: 0, end: 1, byPressure: false } }), line(0, 0, 300, 0));
    const last = r.dabs.data[(r.dabs.count - 1) * DAB_STRIDE + D.SIZE]!;
    const mid = r.dabs.data[Math.floor(r.dabs.count / 2) * DAB_STRIDE + D.SIZE]!;
    expect(last).toBeLessThan(mid * 0.5);
  });
});

describe("symmetry", () => {
  it("mirrors a stroke across the vertical axis", () => {
    const r = run(testBrush({ spacing: 0.5 }), line(10, 20, 40, 20), 1, { mode: "vertical", count: 2, cx: 100, cy: 0 });
    const xs0: number[] = [];
    const xs1: number[] = [];
    for (let i = 0; i < r.dabs.count; i++) (r.dabs.data[i * DAB_STRIDE + 17] === 0 ? xs0 : xs1).push(r.dabs.data[i * DAB_STRIDE + D.X]!);
    expect(xs0.length).toBe(xs1.length);
    for (let i = 0; i < xs0.length; i++) expect(xs1[i]).toBeCloseTo(200 - xs0[i]!, 3);
  });
  it("radial copies rotate about the centre", () => {
    const r = run(testBrush({ spacing: 1 }), [pt(150, 100), pt(160, 100)], 1, { mode: "radial", count: 4, cx: 100, cy: 100 });
    const copy1 = [...Array(r.dabs.count).keys()].filter((i) => r.dabs.data[i * DAB_STRIDE + 17] === 1);
    const o = copy1[0]! * DAB_STRIDE;
    expect(r.dabs.data[o + D.X]).toBeCloseTo(100, 3);
    expect(r.dabs.data[o + D.Y]).toBeCloseTo(150, 3);
  });
});

describe("streamline and smoothing", () => {
  const feed = (s: Smoother, pts: Array<[number, number]>) => {
    const out: Array<[number, number]> = [];
    pts.forEach(([x, y], i) => s.push(pt(x, y, i * 8), (o) => out.push([o.x, o.y])));
    return out;
  };
  it("is the identity at zero", () => {
    const out = feed(new Smoother({ streamline: 0, stabilisation: 0, motionFilter: 0 }), [[0, 0], [10, 5], [20, 0]]);
    expect(out).toEqual([[0, 0], [10, 5], [20, 0]]);
  });
  it("streamline lags behind, then flush reaches the pen", () => {
    const s = new Smoother({ streamline: 0.8, stabilisation: 0, motionFilter: 0 });
    const out = feed(s, [[0, 0], [50, 0], [100, 0]]);
    expect(out[2]![0]).toBeLessThan(100);
    const tail: Array<[number, number]> = [];
    s.flush((o) => tail.push([o.x, o.y]));
    expect(tail.length).toBeGreaterThan(0);
    expect(tail[tail.length - 1]![0]).toBeGreaterThan(99.5);
  });
  it("stabilisation keeps the brush a string's length behind", () => {
    const s = new Smoother({ streamline: 0, stabilisation: 1, motionFilter: 0 });
    const out = feed(s, [[0, 0], [30, 0], [200, 0]]);
    expect(out[1]![0]).toBe(0); // inside the string: no movement yet
    expect(200 - out[2]![0]).toBeCloseTo(60, 3);
  });
  it("motion filter ignores tiny jitter", () => {
    const out = feed(new Smoother({ streamline: 0, stabilisation: 0, motionFilter: 1 }), [[0, 0], [0.3, 0.2], [0.1, 0.3]]);
    expect(out[1]).toEqual(out[0]);
  });
});
