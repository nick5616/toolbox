import { describe, expect, it } from "vitest";
import { Signals } from "../signals";
import { buildEditFixture, FIXTURE_DURATION_MS } from "./fixture";
import { emptyEditProject } from "./defaults";
import { MarkerSignals } from "./markerSignals";
import { deriveMarkers } from "./markers";
import { evalEditParam, interpolateKeys, type ParamContext } from "./params";
import type { EditParam, Key } from "./types";

const a = buildEditFixture();
const markers = deriveMarkers(a, emptyEditProject("9:16", 30, 1).markers, { startMs: 0, endMs: FIXTURE_DURATION_MS });
const ctx: ParamContext = { signals: new Signals(a), markers: new MarkerSignals(a, markers, 0) };

describe("interpolateKeys", () => {
  const k = (t: number, v: number, ease: Key["ease"] = "linear"): Key => ({ t, v, ease });
  it("holds outside the keys", () => {
    const keys = [k(100, 1), k(200, 3)];
    expect(interpolateKeys(keys, 0)).toBe(1);
    expect(interpolateKeys(keys, 100)).toBe(1);
    expect(interpolateKeys(keys, 999)).toBe(3);
  });
  it("linear, ease and hold segments use the starting key's ease", () => {
    expect(interpolateKeys([k(0, 0), k(100, 10)], 25)).toBeCloseTo(2.5);
    expect(interpolateKeys([k(0, 0, "ease"), k(100, 10)], 25)).toBeCloseTo(10 * (0.25 * 0.25 * (3 - 0.5)));
    expect(interpolateKeys([k(0, 0, "ease"), k(100, 10)], 50)).toBeCloseTo(5);
    expect(interpolateKeys([k(0, 2, "hold"), k(100, 10)], 99)).toBe(2);
    expect(interpolateKeys([k(0, 2, "hold"), k(100, 10)], 100)).toBe(10);
  });
  it("finds the right segment among many keys", () => {
    const keys = [k(0, 0), k(10, 10), k(20, 0), k(30, 30)];
    expect(interpolateKeys(keys, 15)).toBeCloseTo(5);
    expect(interpolateKeys(keys, 25)).toBeCloseTo(15);
    expect(interpolateKeys([k(5, 7)], 100)).toBe(7);
    expect(interpolateKeys([], 1)).toBe(0);
  });
  it("two keys at the same time do not divide by zero", () => {
    expect(Number.isFinite(interpolateKeys([k(10, 1), k(10, 5)], 10))).toBe(true);
    expect(interpolateKeys([k(10, 1), k(10, 5)], 11)).toBe(5);
  });
});

describe("evalEditParam", () => {
  it("numbers clamp", () => {
    expect(evalEditParam(5, 0, 1, 0, 0, null)).toBe(1);
    expect(evalEditParam(-5, 0, 1, 0, 0, ctx)).toBe(0);
  });

  it("base, keys; mods ignored without a context", () => {
    const p: EditParam = { base: 0.5, mods: [{ signal: "marker.kick", amount: 1, shape: "linear" }] };
    expect(evalEditParam(p, 0, 2, 0, 1000, null)).toBe(0.5);
    const keyed: EditParam = { base: 0, keys: [{ t: 0, v: 1, ease: "linear" }, { t: 1000, v: 2, ease: "linear" }] };
    expect(evalEditParam(keyed, 0, 3, 500, 0, null)).toBeCloseTo(1.5);
    expect(evalEditParam(keyed, 0, 3, 5000, 0, null)).toBe(2);
  });

  it("marker mod: amount is a fraction of the range", () => {
    const p: EditParam = { base: 0, mods: [{ signal: "marker.kick", amount: 0.5, shape: "linear", attackMs: 1, releaseMs: 50 }] };
    const hit = evalEditParam(p, 0, 2, 0, 1000, ctx);
    expect(hit).toBeCloseTo(0.6, 1); // 0.5 * 2 * the kick's strength 0.6
    expect(hit).toBeLessThanOrEqual(1);
    expect(evalEditParam(p, 0, 2, 0, 1400, ctx)).toBeLessThan(0.1);
  });

  it("viz signals use Signals.value", () => {
    const p: EditParam = { base: 0, mods: [{ signal: "mix.level", amount: 1, shape: "linear" }] };
    const want = ctx.signals.value("mix.level", 9000, 10, 180);
    expect(evalEditParam(p, 0, 1, 0, 9000, ctx)).toBeCloseTo(want, 6);
  });

  it("keys and mods add, then clamp", () => {
    const p: EditParam = { base: 0, keys: [{ t: 0, v: 0.8, ease: "linear" }], mods: [{ signal: "marker.kick", amount: 1, shape: "linear", attackMs: 1, releaseMs: 50 }] };
    expect(evalEditParam(p, 0, 1, 0, 1000, ctx)).toBe(1);
    expect(evalEditParam(p, 0, 1, 0, 1400, ctx)).toBeCloseTo(0.8, 1);
  });

  it("section gate: only inside listed sections", () => {
    const p: EditParam = { base: 0, mods: [{ signal: "marker.kick", amount: 1, shape: "linear", sections: ["chorus"] }] };
    expect(evalEditParam(p, 0, 1, 0, 9000, ctx)).toBeGreaterThan(0.7);
    expect(evalEditParam(p, 0, 1, 0, 5000, ctx)).toBe(0);
    const viz: EditParam = { base: 0, mods: [{ signal: "mix.level", amount: 1, shape: "linear", sections: ["verse"] }] };
    expect(evalEditParam(viz, 0, 1, 0, 9000, ctx)).toBe(0);
    expect(evalEditParam(viz, 0, 1, 0, 5000, ctx)).toBeGreaterThan(0);
  });

  it("every on a marker mod", () => {
    const p: EditParam = { base: 0, mods: [{ signal: "marker.kick", amount: 1, shape: "linear", every: 4, attackMs: 1, releaseMs: 50 }] };
    expect(evalEditParam(p, 0, 1, 0, 2000, ctx)).toBeGreaterThan(0.5);
    expect(evalEditParam(p, 0, 1, 0, 2500, ctx)).toBeLessThan(0.1);
  });

  it("negative amounts, shapes and missing marker signals", () => {
    const neg: EditParam = { base: 1, mods: [{ signal: "marker.kick", amount: -0.5, shape: "gate", attackMs: 1, releaseMs: 50 }] };
    expect(evalEditParam(neg, 0, 2, 0, 1000, ctx)).toBeCloseTo(0);
    const none: EditParam = { base: 0.3, mods: [{ signal: "marker.kick", amount: 1, shape: "linear" }] };
    expect(evalEditParam(none, 0, 1, 0, 1000, { signals: ctx.signals, markers: null })).toBe(0.3);
  });

  it("is deterministic", () => {
    const p: EditParam = { base: 0.1, mods: [{ signal: "marker.snare", amount: 0.7, shape: "exp" }, { signal: "beat.pulse", amount: 0.2, shape: "ease" }] };
    const x = evalEditParam(p, 0, 1, 0, 3333, ctx);
    expect(evalEditParam(p, 0, 1, 0, 3333, ctx)).toBe(x);
  });
});
