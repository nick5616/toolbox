import { describe, expect, it } from "vitest";
import { buildFixture } from "./fixture";
import { beatCount, beatRate, INTEGRAL_STEP_MS, Integrator, rateAt, type RateEnv } from "./integral";
import { Signals } from "./signals";

const A = buildFixture({ durationMs: 60_000 });
const S = new Signals(A);

function env(param: (name: string, t: number) => number | undefined, speed = 1, calls?: { n: number }): RateEnv {
  return {
    analysis: A,
    signals: S,
    intensity: 1,
    speed,
    param: (name, t) => {
      if (calls) calls.n++;
      return param(name, t);
    },
  };
}

describe("integrals of rates", () => {
  it("equals rate x time for a constant parameter, and scales with the show speed", () => {
    const e = env(() => 1.5);
    const i = new Integrator();
    for (const t of [1, 100, 1234, 5000, 33_333, 59_000]) expect(i.value("a", "p", false, "s", e, t)).toBeCloseTo(1.5 * (t / 1000), 9);
    const fast = new Integrator();
    expect(fast.value("a", "p*0.5", false, "s", env(() => 1.5, 2), 4000)).toBeCloseTo(1.5 * 0.5 * 4 * 2, 9);
    expect(i.value("a", "p", false, "s", e, 0)).toBe(0);
    expect(i.value("a", "p", false, "s", e, -50)).toBe(0);
  });

  it("measures beats for beatIntegral: a constant rate gives rate x beats elapsed", () => {
    const e = env(() => 2);
    const i = new Integrator();
    for (const t of [500, 2_000, 7_300, 30_000]) expect(i.value("a", "p", true, "s", e, t)).toBeCloseTo(2 * beatCount(A, t), 2);
    expect(beatRate(A, 10_000)).toBeCloseTo(2, 6); // 120 bpm
  });

  it("follows a signal factor like the analysis' own cumulative sum", () => {
    const e = env(() => undefined);
    const i = new Integrator();
    for (const t of [5_000, 20_000, 45_000]) {
      const got = i.value("a", "mix.level", false, "s", e, t);
      const want = A.cum("mix.level", t);
      expect(Math.abs(got - want)).toBeLessThan(0.02 * Math.max(1, want));
    }
    expect(rateAt("p*intensity*0.5", { ...env(() => 4), intensity: 2 }, 100, false)).toBe(4);
    expect(rateAt("nonsense", env(() => undefined), 100, false)).toBe(0);
  });

  it("gives the same value whatever order the times are asked in (preview and export agree)", () => {
    const rate = (name: string, t: number) => (name === "p" ? 1 + Math.sin(t / 700) : undefined);
    const times = [40_000, 1_000, 25_000, 25_001, 7_777, 59_999, 120, 33_000];
    const a = new Integrator();
    const b = new Integrator();
    const ascending = [...times].sort((x, y) => x - y);
    const fromA = new Map(times.map((t) => [t, a.value("k", "p*kick", false, "s", env(rate), t)]));
    const fromB = new Map(ascending.map((t) => [t, b.value("k", "p*kick", false, "s", env(rate), t)]));
    for (const t of times) expect(fromA.get(t)).toBe(fromB.get(t));
  });

  it("extends lazily and keeps what it has on a backward seek", () => {
    const calls = { n: 0 };
    const e = env(() => 1, 1, calls);
    const i = new Integrator();
    i.value("a", "p", false, "s", e, 1_000);
    const first = calls.n;
    expect(first).toBeLessThan(140); // about 120 steps, not the whole song
    const at5 = i.value("a", "p", false, "s", e, 5_000);
    const afterForward = calls.n;
    expect(afterForward - first).toBeGreaterThan(400);
    const back = i.value("a", "p", false, "s", e, 2_000);
    expect(calls.n - afterForward).toBeLessThanOrEqual(2); // the prefix is reused: only the partial step is evaluated
    expect(back).toBeCloseTo(2, 9);
    expect(i.value("a", "p", false, "s", e, 5_000)).toBe(at5);
  });

  it("restarts a cache when its signature changes, and keeps instances apart", () => {
    const i = new Integrator();
    expect(i.value("a", "p", false, "one", env(() => 1), 2_000)).toBeCloseTo(2, 9);
    expect(i.value("a", "p", false, "two", env(() => 3), 2_000)).toBeCloseTo(6, 9);
    expect(i.value("b", "p", false, "one", env(() => 1), 2_000)).toBeCloseTo(2, 9);
  });

  it("is continuous when the rate steps: it moves by at most the rate times the elapsed time", () => {
    const step = (name: string, t: number) => (name === "p" ? (t >= 10_000 ? 3 : 0) : undefined);
    const i = new Integrator();
    const e = env(step);
    const dt = 1000 / 60;
    let prev = i.value("a", "p", false, "s", e, 9_000);
    for (let t = 9_000 + dt; t < 11_000; t += dt) {
      const v = i.value("a", "p", false, "s", e, t);
      expect(v - prev).toBeGreaterThanOrEqual(0);
      expect(v - prev).toBeLessThanOrEqual(3 * (dt / 1000) + 1e-9);
      prev = v;
    }
    expect(INTEGRAL_STEP_MS).toBeCloseTo(1000 / 120, 9);
  });
});
