import { describe, expect, it } from "vitest";
import { buildFixture } from "../fixture";
import { resolvePalette } from "../palette";
import { Signals } from "../signals";
import { barPosition, beatPosition, clamp01, cumSignal, drive, speedScale } from "./_bg/util";
import "./index";
import { layerDef, makeRng, type FrameInput, type ParamValues } from "./registry";

const L1 = ["nebula", "aurora", "ink", "synthgrid", "tunnel", "starfield", "terrain", "image", "kaleido"] as const;

const SHARED = buildFixture({ durationMs: 30_000 });
const SIGNALS = new Signals(SHARED);

function frameAt(tMs: number, params: ParamValues = {}): FrameInput {
  const analysis = SHARED;
  return {
    tMs,
    dtMs: 1000 / 30,
    motionSec: tMs / 1000,
    params,
    opacity: 1,
    palette: resolvePalette({ mode: "fixed", ids: ["cyber"] }, analysis, tMs),
    analysis,
    signals: SIGNALS,
    w: 1280,
    h: 720,
    seed: 1,
    quality: "full",
    mode: "opaque",
  };
}

describe("L1 background layer definitions", () => {
  it("registers every layer as a background with sane parameters", () => {
    for (const type of L1) {
      const def = layerDef(type);
      expect(def, type).toBeDefined();
      expect(def?.group, type).toBe("background");
      const params = Object.entries(def?.params ?? {});
      expect(params.length, type).toBeGreaterThanOrEqual(4);
      for (const [name, spec] of params) {
        if (spec.kind === "number") {
          expect(spec.min, `${type}.${name}`).toBeLessThan(spec.max);
          expect(spec.default, `${type}.${name}`).toBeGreaterThanOrEqual(spec.min);
          expect(spec.default, `${type}.${name}`).toBeLessThanOrEqual(spec.max);
        }
        if (spec.kind === "enum") expect(spec.options).toContain(spec.default);
      }
    }
  });

  it("marks only the kaleidoscope as stateful", () => {
    for (const type of L1) expect(Boolean(layerDef(type)?.stateful), type).toBe(type === "kaleido");
  });

  it("gives the image layer a source choice and the terrain a row range of 24-64", () => {
    const src = layerDef("image")?.params.source;
    expect(src?.kind === "enum" && src.options).toEqual(["auto", "cover", "image"]);
    const rows = layerDef("terrain")?.params.rows;
    expect(rows?.kind === "number" && [rows.min, rows.max]).toEqual([24, 64]);
    const bands = layerDef("aurora")?.params.bands;
    expect(bands?.kind === "number" && [bands.min, bands.max]).toEqual([3, 8]);
    const blobs = layerDef("ink")?.params.blobs;
    expect(blobs?.kind === "number" && [blobs.min, blobs.max]).toEqual([4, 12]);
  });
});

describe("background helpers", () => {
  it("integrates a signal monotonically and matches a direct sum", () => {
    const f = frameAt(0);
    const s = f.signals;
    expect(cumSignal(s, "kick", 0)).toBe(0);
    let prev = 0;
    for (let t = 0; t <= 20_000; t += 500) {
      const c = cumSignal(s, "drums.level", t);
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
    const series = s.get("mix.level");
    let sum = 0;
    for (let i = 0; i < 300; i++) sum += (series[i] ?? 0) / s.fps;
    expect(cumSignal(s, "mix.level", (300 / s.fps) * 1000)).toBeCloseTo(sum, 6);
  });

  it("moves the beat position forward continuously, surging within each beat", () => {
    let prev = beatPosition(frameAt(590), 0.8);
    for (let t = 600; t < 6000; t += 10) {
      const p = beatPosition(frameAt(t), 0.8);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(p - prev).toBeLessThan(0.2);
      prev = p;
    }
    // 120 bpm: beat index 2 at 1000 ms
    expect(beatPosition(frameAt(1000), 0.8)).toBeCloseTo(2, 5);
    // an eased beat is behind a linear one early in the beat and ahead of it late
    expect(beatPosition(frameAt(1100), 1)).toBeLessThan(beatPosition(frameAt(1100), 0));
    expect(beatPosition(frameAt(1400), 1)).toBeGreaterThan(beatPosition(frameAt(1400), 0));
    expect(barPosition(frameAt(5000))).toBeCloseTo(2.5, 5);
  });

  it("keeps the drive within range, scales with react and is deterministic", () => {
    const a = drive(frameAt(20_000), 1);
    const b = drive(frameAt(20_000), 1);
    expect(a).toEqual(b);
    for (const [k, v] of Object.entries(a)) {
      expect(Number.isFinite(v), k).toBe(true);
      expect(Math.abs(v), k).toBeLessThanOrEqual(2);
    }
    const off = drive(frameAt(20_000), 0);
    expect(off.bass).toBe(0);
    expect(off.kick).toBe(0);
    expect(off.drop).toBe(0);
    expect(drive(frameAt(20_000), 2).bass).toBeGreaterThanOrEqual(a.bass);
  });

  it("scales cumulative terms with the show speed", () => {
    const f = frameAt(10_000);
    expect(speedScale(f)).toBeCloseTo(1, 6);
    expect(speedScale({ ...f, motionSec: 20 })).toBeCloseTo(2, 6);
    expect(speedScale(frameAt(0))).toBe(1);
  });

  it("clamps and seeds deterministically", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    const r1 = makeRng(1, "ink");
    const r2 = makeRng(1, "ink");
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
    expect(makeRng(2, "ink")()).not.toBe(makeRng(1, "ink")());
  });
});
