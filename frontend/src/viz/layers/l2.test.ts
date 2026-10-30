import { describe, expect, it } from "vitest";
import { buildFixture } from "../fixture";
import { paletteById, hexToLinear, resolvePalette } from "../palette";
import { LAYER_TYPES } from "../types";
import { laneFlash, lowerBound } from "./highway";
import { layerDef } from "./index";
import {
  BAND_LANES,
  buildRamp,
  catmull,
  hyperDepth,
  hyperTime,
  INSTRUMENT_LANES,
  laneNotes,
  mirrorU,
  pickPeaks,
  polygonPoints,
  rampAt,
  smooth5,
  snapSmooth,
  sustainMs,
  voicedRuns,
  wobble,
} from "./l2util";

const L2 = ["bars", "radial", "ribbons", "wavering", "oscilloscope", "lissajous", "helix", "vortex", "geometry", "pitchribbon", "highway"] as const;

describe("L2 layer definitions", () => {
  it("registers every L2 type with sane params", () => {
    for (const t of L2) {
      const def = layerDef(t);
      expect(def, t).toBeDefined();
      expect(LAYER_TYPES).toContain(t);
      for (const [k, spec] of Object.entries(def?.params ?? {})) {
        if (spec.kind === "number") {
          expect(spec.min, `${t}.${k}`).toBeLessThan(spec.max);
          expect(spec.default, `${t}.${k}`).toBeGreaterThanOrEqual(spec.min);
          expect(spec.default, `${t}.${k}`).toBeLessThanOrEqual(spec.max);
        }
        if (spec.kind === "enum") expect(spec.options, `${t}.${k}`).toContain(spec.default);
      }
    }
  });
  it("groups shapes and the highway", () => {
    expect(layerDef("highway")?.group).toBe("highway");
    expect(layerDef("radial")?.group).toBe("shape");
  });
});

describe("palette ramps", () => {
  const pal = paletteById("cyber");
  const resolved = resolvePalette({ mode: "fixed", ids: ["cyber"] }, null, 0);
  it("a single colour mode is constant", () => {
    const r = buildRamp(resolved, "accent", 8);
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    rampAt(r, 0.1, a);
    rampAt(r, 0.8, b);
    expect(a).toEqual(b);
    expect(a[1]).toBeCloseTo(resolved.accent[1], 5);
  });
  it("cycle starts at colour 0 and wraps seamlessly", () => {
    const r = buildRamp(resolved, "cycle", 24);
    const o = [0, 0, 0];
    rampAt(r, 0, o);
    expect(o[0]).toBeCloseTo(resolved.colors[0][0], 4);
    const p = [0, 0, 0];
    rampAt(r, 1, p);
    expect(p).toEqual(o);
    rampAt(r, -1, p);
    expect(p).toEqual(o);
  });
  it("palette data is there", () => {
    expect(pal.colors).toHaveLength(4);
    expect(hexToLinear("#ffffff")[0]).toBeCloseTo(1, 5);
  });
});

describe("sampling helpers", () => {
  it("catmull passes through the samples and clamps", () => {
    const a = [0, 1, 0, 1];
    expect(catmull(a, 1)).toBeCloseTo(1, 6);
    expect(catmull(a, -3)).toBe(0);
    expect(catmull(a, 99)).toBe(1);
    expect(catmull([], 1)).toBe(0);
  });
  it("snapSmooth stays on integers except near the halfway points", () => {
    expect(snapSmooth(3)).toBe(3);
    expect(snapSmooth(3.2)).toBe(3);
    expect(snapSmooth(3.95)).toBeCloseTo(4, 5);
    const mid = snapSmooth(3.75);
    expect(mid).toBeGreaterThan(3);
    expect(mid).toBeLessThan(4);
  });
  it("mirrorU is 1 at the ends and 0 in the middle", () => {
    expect(mirrorU(0)).toBe(1);
    expect(mirrorU(0.5)).toBe(0);
    expect(mirrorU(1)).toBe(1);
    expect(mirrorU(0.25)).toBeCloseTo(0.5, 6);
  });
  it("smooth5 keeps constants and softens spikes", () => {
    const c = smooth5(new Float32Array([2, 2, 2, 2, 2]));
    expect([...c]).toEqual([2, 2, 2, 2, 2]);
    const s = smooth5(new Float32Array([0, 0, 16, 0, 0]));
    expect(s[2]).toBeCloseTo(6, 4);
    expect(s[1]).toBeCloseTo(4, 4);
  });
  it("wobble is periodic in theta for integer lobes and bounded", () => {
    const a = wobble(0.7, 6, 1, 2, 3);
    const b = wobble(0.7 + Math.PI * 2, 6, 1, 2, 3);
    expect(a).toBeCloseTo(b, 9);
    for (let i = 0; i < 100; i++) expect(Math.abs(wobble(i * 0.37, 8, i, i * 2, i * 3))).toBeLessThanOrEqual(1);
  });
  it("polygon corners sit on the circle", () => {
    const pts = polygonPoints(6, 100, 0.3, 10, 20);
    expect(pts).toHaveLength(6);
    for (const [x, y] of pts) expect(Math.hypot(x - 10, y - 20)).toBeCloseTo(100, 6);
  });
});

describe("highway perspective", () => {
  it("hits the fret at dt 0 and recedes monotonically", () => {
    expect(hyperDepth(0, 3)).toBe(1);
    expect(hyperDepth(-1, 3)).toBe(1);
    let prev = 1;
    for (let dt = 0.1; dt < 4; dt += 0.1) {
      const s = hyperDepth(dt, 3);
      expect(s).toBeLessThan(prev);
      expect(s).toBeGreaterThan(0);
      prev = s;
    }
  });
  it("hyperTime inverts hyperDepth", () => {
    for (const dt of [0.2, 1, 2.5]) expect(hyperTime(hyperDepth(dt, 3.2), 3.2)).toBeCloseTo(dt, 9);
  });
  it("lowerBound finds the first element at or after t", () => {
    const a = [0, 500, 1000, 1500];
    expect(lowerBound(a, 0)).toBe(0);
    expect(lowerBound(a, 501)).toBe(2);
    expect(lowerBound(a, 9999)).toBe(4);
  });
});

describe("peaks, sustains and runs", () => {
  it("picks onsets with a minimum gap and keeps the stronger one", () => {
    const fps = 100;
    const arr = new Float32Array(300);
    arr[100] = 0.8;
    arr[110] = 0.9; // 100 ms later: merges into the stronger
    arr[200] = 0.7;
    const peaks = pickPeaks(arr, fps, 0, 3000, 0.3, 300);
    expect(peaks.map((p) => p.t)).toEqual([1100, 2000]);
    expect(pickPeaks(arr, fps, 0, 3000, 0.95, 300)).toHaveLength(0);
  });
  it("measures a sustain until the level falls", () => {
    const fps = 100;
    const arr = new Float32Array(200).fill(0);
    for (let i = 50; i < 90; i++) arr[i] = 0.8;
    expect(sustainMs(arr, fps, 500, 2000)).toBeCloseTo(390, -1);
    expect(sustainMs(arr, fps, 500, 100)).toBeCloseTo(100, -1);
    expect(sustainMs(arr, fps, 1500, 2000)).toBe(0);
  });
  it("finds voiced runs and ignores single samples", () => {
    expect(voicedRuns([0, 1, 1, 0, 1, 0, 1, 1, 1], 0.5, 2)).toEqual([
      [1, 2],
      [6, 8],
    ]);
    expect(voicedRuns([], 0.5)).toEqual([]);
  });
});

describe("lane notes from the analysis", () => {
  const a = buildFixture({ durationMs: 30_000 });
  it("a kick lane reproduces the kick events at exactly their times", () => {
    const notes = laneNotes(a, INSTRUMENT_LANES[0] as (typeof INSTRUMENT_LANES)[number], 4000, 7000);
    expect(notes.map((n) => n.t)).toEqual(a.eventsBetween("kick", 4000, 7000).map((e) => e[0]));
    for (const n of notes) {
      expect(n.s).toBeGreaterThan(0);
      expect(n.s).toBeLessThanOrEqual(1);
      expect(n.dur).toBe(0);
    }
  });
  it("is stateless: the same window gives the same notes", () => {
    const l = INSTRUMENT_LANES[3] as (typeof INSTRUMENT_LANES)[number];
    expect(laneNotes(a, l, 5000, 9000)).toEqual(laneNotes(a, l, 5000, 9000));
  });
  it("vocal lane turns held notes into sustains", () => {
    const held = a.held()[0] as [number, number, number];
    const notes = laneNotes(a, INSTRUMENT_LANES[4] as (typeof INSTRUMENT_LANES)[number], held[0] - 500, held[1] + 500);
    const sus = notes.find((n) => n.t === held[0]);
    expect(sus).toBeDefined();
    expect(sus?.dur).toBe(held[1] - held[0]);
    // events inside the held note are swallowed
    expect(notes.filter((n) => n.t > held[0] + 150 && n.t < held[1] && n.dur === 0)).toHaveLength(0);
  });
  it("falls back to picking channel peaks without events (no stems)", () => {
    const b = buildFixture({ durationMs: 30_000, stems: false });
    // wipe the events so only the channel fallback is left
    for (const k of Object.keys(b.audio.events)) b.audio.events[k] = [];
    const notes = laneNotes(b, INSTRUMENT_LANES[0] as (typeof INSTRUMENT_LANES)[number], 2000, 12_000);
    expect(notes.length).toBeGreaterThan(3);
    for (const n of notes) expect(n.t % 1).toBeCloseTo(0, 0);
  });
  it("band lanes produce notes from the channels", () => {
    const total = BAND_LANES.map((l) => laneNotes(a, l, 20_000, 30_000).length);
    expect(total.reduce((x, y) => x + y, 0)).toBeGreaterThan(0);
  });
  it("laneFlash peaks at the hit, decays, and holds during a sustain", () => {
    const hit = [{ t: 1000, s: 1, dur: 0 }];
    expect(laneFlash(hit, 500)).toBe(0);
    expect(laneFlash(hit, 950)).toBeGreaterThan(0);
    const atHit = laneFlash(hit, 1000);
    expect(atHit).toBeGreaterThan(1);
    expect(laneFlash(hit, 1300)).toBeLessThan(atHit);
    expect(laneFlash(hit, 2500)).toBe(0);
    const sus = [{ t: 1000, s: 1, dur: 1500 }];
    expect(laneFlash(sus, 2000)).toBeGreaterThan(0.5);
    expect(laneFlash(sus, 3000)).toBeLessThan(0.3);
  });
});
