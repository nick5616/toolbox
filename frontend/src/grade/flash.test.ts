import { describe, expect, it } from "vitest";
import { surprise } from "./chaos";
import { beatEnv, flashesPerSec, recipeFlashes, simulateMeanLuma } from "./flash";
import { BUILT_IN_LOOKS } from "./builtins";
import type { GradeOp, GradeRecipe } from "./types";

const series = (f: (t: number) => number, seconds = 10, fps = 30) => Array.from({ length: seconds * fps }, (_, i) => f(i / fps));

describe("flashesPerSec (WCAG general flashes)", () => {
  it("counts a 3 Hz square wave as 3 flashes a second, and a steady picture as none", () => {
    expect(flashesPerSec(series(() => 0.5), 30)).toBe(0);
    const f = flashesPerSec(series((t) => (Math.floor(t * 6) % 2 === 0 ? 0.2 : 0.8)), 30);
    expect(f).toBeGreaterThanOrEqual(2.5);
    expect(f).toBeLessThanOrEqual(3.5);
  });

  it("ignores swings under 10%, however fast", () => {
    expect(flashesPerSec(series((t) => 0.5 + (Math.floor(t * 20) % 2 === 0 ? 0.04 : -0.04)), 30)).toBe(0);
  });

  it("a slow big swing (0.5 Hz) is under one flash a second", () => {
    expect(flashesPerSec(series((t) => 0.5 + 0.4 * Math.sin(2 * Math.PI * 0.5 * t)), 30)).toBeLessThan(1);
  });

  it("a 6 Hz square wave is far over the limit", () => {
    expect(flashesPerSec(series((t) => (Math.floor(t * 12) % 2 === 0 ? 0.1 : 0.9)), 30)).toBeGreaterThan(3);
  });
});

describe("beat envelope", () => {
  it("rises over 120 ms and falls over 300 ms, never a square", () => {
    expect(beatEnv(0, 500)).toBe(0);
    expect(beatEnv(60, 500)).toBeCloseTo(0.5, 9);
    expect(beatEnv(120, 500)).toBe(1);
    expect(beatEnv(270, 500)).toBeCloseTo(0.5, 9);
    expect(beatEnv(420, 500)).toBe(0);
    expect(beatEnv(500 + 60, 500)).toBeCloseTo(0.5, 9);
  });
});

describe("flash safety of looks (≤ 3 flashes a second)", () => {
  const animated = BUILT_IN_LOOKS.filter((l) => l.recipe.ops.some((o) => o.anim));

  it("there are animated built-in looks to test", () => {
    expect(animated.length).toBeGreaterThanOrEqual(8);
  });

  it("every animated built-in look at Wildness 0.5, 0.8 and 1, on a 180 bpm track", () => {
    for (const l of animated) {
      for (const w of [0.5, 0.8, 1]) {
        const f = recipeFlashes(l.recipe, w, { seconds: 8, bpm: 180 });
        expect(f, `${l.id} @${w}`).toBeLessThanOrEqual(3);
      }
    }
  });

  it("the worst case: strong ops pulsing on every beat of a fast track", () => {
    const op = (kind: GradeOp["kind"], i: number, wave: "beat" | "bar" | "sine"): GradeOp => ({ id: `w0000${i}`, kind, on: true, amount: 1, region: { kind: "all" }, params: {}, anim: { speed: 6, wave } });
    const r: GradeRecipe = { v: 1, name: "worst", tier: "mine", seed: 0, wildCurve: "linear", ops: [op("solarize", 0, "beat"), op("balance", 1, "beat"), op("gradmap", 2, "sine"), op("bleach", 3, "bar"), op("glow", 4, "beat")] };
    for (const bpm of [120, 180, 240]) expect(recipeFlashes(r, 1, { seconds: 8, bpm }), `${bpm} bpm`).toBeLessThanOrEqual(3);
    // and the pulses are there: the series isn't flat
    const s = simulateMeanLuma(r, 1, { seconds: 4, bpm: 120 });
    expect(Math.max(...s) - Math.min(...s)).toBeGreaterThan(0.01);
  });

  it("200 Chaos seeds with every animatable op pulsing on the beat", () => {
    let withAnim = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const r = surprise(seed, (seed % 10) / 9);
      // Chaos only draws slow sine drifts; also force every animatable op to a beat pulse (the harsher test).
      const pulsing: GradeRecipe = { ...r, ops: r.ops.map((o) => (["balance", "split", "gradmap", "solarize", "bleach", "glow", "halation", "edgeglow", "grain", "vignette"].includes(o.kind) ? { ...o, anim: { speed: 6, wave: "beat" as const } } : o)) };
      if (pulsing.ops.some((o) => o.anim)) withAnim++;
      expect(recipeFlashes(r, 1, { seconds: 6, bpm: 180 }), `seed ${seed} as drawn`).toBeLessThanOrEqual(3);
      expect(recipeFlashes(pulsing, 1, { seconds: 6, bpm: 180 }), `seed ${seed} pulsing`).toBeLessThanOrEqual(3);
    }
    expect(withAnim).toBeGreaterThan(100);
  }, 120000);
});
