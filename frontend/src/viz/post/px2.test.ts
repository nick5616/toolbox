import { describe, expect, it } from "vitest";
import { chromaticPx, glitchStrength, shakeOffset, zoomPulseScale } from "./px1math";
import {
  blurSigmaPx,
  blurStepPx,
  exposureGain,
  flashAlpha,
  flashChannel,
  flashGain,
  gaussWeights,
  invertChannel,
  punchTransform,
  rotationCover,
  triggerDrive,
} from "./px2math";
import { postDef } from "./index";
import type { PostType } from "../types";

describe("trigger params (additive, defaults unchanged)", () => {
  it("default and legacy values keep the hard-wired signal", () => {
    for (const t of [undefined, "kick", "beat", "drop", "", 3]) {
      expect(triggerDrive(t, () => 0.37)).toBe(0.37);
    }
  });
  it("amount replaces the signal with 1 and never reads it", () => {
    expect(triggerDrive("amount", () => { throw new Error("read"); })).toBe(1);
  });
  it("default drive reproduces the PX1 math exactly", () => {
    const kick = 0.62;
    expect(shakeOffset(1234, 5, triggerDrive("kick", () => kick), 720, 0.5)).toEqual(shakeOffset(1234, 5, kick, 720, 0.5));
    expect(zoomPulseScale(triggerDrive("beat", () => kick), 0.35)).toBe(zoomPulseScale(kick, 0.35));
    expect(glitchStrength(triggerDrive("drop", () => kick), 0.7)).toBe(glitchStrength(kick, 0.7));
  });
  it("amount makes Amount the whole strength", () => {
    expect(zoomPulseScale(triggerDrive("amount", () => 0), 1)).toBeCloseTo(1.03);
    expect(glitchStrength(triggerDrive("amount", () => 0), 0.4)).toBeCloseTo(0.4);
    const [x, y] = shakeOffset(500, 1, triggerDrive("amount", () => 0), 720, 1);
    expect(Math.abs(x) + Math.abs(y)).toBeGreaterThan(0);
    // chromatic "amount": drive 1, radius equals the amount (at 720 lines)
    expect(chromaticPx(6, 1, 720)).toBeCloseTo(6);
  });
  it("registers the enum options (calm defaults: zoom on bars, chromatic on drops)", () => {
    const want: [PostType, string, string[], string][] = [
      ["shake", "trigger", ["kick", "amount"], "kick"],
      ["zoompulse", "trigger", ["bar", "beat", "amount"], "bar"],
      ["glitch", "trigger", ["drop", "amount"], "drop"],
    ];
    for (const [type, key, opts, def] of want) {
      const p = postDef(type)?.params[key];
      expect(p).toMatchObject({ kind: "enum", options: opts, default: def });
    }
    const src = postDef("chromatic")?.params.source;
    expect(src).toMatchObject({ kind: "enum", default: "drop" });
    expect(src && src.kind === "enum" ? src.options : []).toEqual(["drop", "kick", "snare", "balance", "none", "amount"]);
  });
});

describe("zoom punch", () => {
  it("is the identity at amount 0", () => {
    expect(punchTransform(0, 0.4, 10, 1, 1280, 720)).toEqual({ scale: 1, angle: 0, blurPx: 0 });
  });
  it("scales by 1 + zoom*amount and blurs 2% of the short side at most", () => {
    const t = punchTransform(1, 0.15, 0, 1, 1280, 720);
    expect(t.scale).toBeCloseTo(1.15);
    expect(t.blurPx).toBeCloseTo(0.02 * 720);
    expect(punchTransform(0.5, 0.2, 0, 0.3, 1000, 1000).scale).toBeCloseTo(1.1);
  });
  it("rotates rotate*amount degrees and covers the border", () => {
    const t = punchTransform(0.5, 0, 10, 0, 1280, 720);
    expect(t.angle).toBeCloseTo((5 * Math.PI) / 180);
    expect(t.scale).toBeGreaterThan(1);
    expect(rotationCover(0, 1280, 720)).toBe(1);
    // Corner of the unrotated frame must stay inside the scaled, rotated picture.
    const a = (5 * Math.PI) / 180;
    const s = rotationCover(a, 1280, 720);
    const x = 640, y = 360;
    const rx = (Math.cos(a) * x + Math.sin(a) * y) / s;
    const ry = (-Math.sin(a) * x + Math.cos(a) * y) / s;
    expect(Math.abs(rx)).toBeLessThanOrEqual(640 + 1e-9);
    expect(Math.abs(ry)).toBeLessThanOrEqual(360 + 1e-9);
  });
  it("is symmetric in rotation sign", () => {
    expect(rotationCover(-0.2, 1920, 1080)).toBeCloseTo(rotationCover(0.2, 1920, 1080));
  });
});

describe("flash", () => {
  it("adds colour * amount * 1.6 and raises alpha to the amount", () => {
    expect(flashGain(0)).toBe(0);
    expect(flashGain(1)).toBeCloseTo(1.6);
    expect(flashGain(2)).toBeCloseTo(1.6);
    expect(flashChannel(0.2, 1, 0.5, "add")).toBeCloseTo(1.0);
    expect(flashChannel(0.2, 0.5, 1, "add")).toBeCloseTo(1.0);
    expect(flashAlpha(0.1, 0.6)).toBe(0.6);
    expect(flashAlpha(0.9, 0.6)).toBe(0.9);
  });
  it("screen never exceeds 1 for inputs in 0..1", () => {
    for (const c of [0, 0.3, 0.8, 1]) expect(flashChannel(c, 1, 1, "screen")).toBeLessThanOrEqual(1 + 1e-9);
    expect(flashChannel(0.5, 1, 0.5, "screen")).toBeCloseTo(0.5 + 0.8 - 0.4);
    expect(flashChannel(0.4, 1, 0, "screen")).toBeCloseTo(0.4);
  });
});

describe("blur pulse", () => {
  it("sigma is radius * amount * short side", () => {
    expect(blurSigmaPx(0.02, 1, 720)).toBeCloseTo(14.4);
    expect(blurSigmaPx(0.02, 0, 720)).toBe(0);
    expect(blurSigmaPx(0.05, 0.5, 1000)).toBeCloseTo(25);
  });
  it("steps cover about 3 sigma and never drop below a pixel", () => {
    expect(blurStepPx(1)).toBe(1);
    expect(blurStepPx(32)).toBeCloseTo(12);
  });
  it("weights are normalised and decreasing", () => {
    const w = gaussWeights(10, 4, 8);
    const sum = w[0]! + 2 * w.slice(1).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1);
    for (let i = 1; i < w.length; i++) expect(w[i]!).toBeLessThan(w[i - 1]!);
    expect(gaussWeights(0, 1, 4)).toEqual([1, 0, 0, 0, 0]);
  });
});

describe("exposure and invert", () => {
  it("gain is 2^(stops*amount)", () => {
    expect(exposureGain(0, 1.5)).toBe(1);
    expect(exposureGain(1, 1)).toBe(2);
    expect(exposureGain(-1, 2)).toBeCloseTo(0.25);
    expect(exposureGain(5, 1)).toBe(2);
  });
  it("invert mixes rgb toward alpha - rgb (premultiplied)", () => {
    expect(invertChannel(0.3, 1, 0)).toBeCloseTo(0.3);
    expect(invertChannel(0.3, 1, 1)).toBeCloseTo(0.7);
    expect(invertChannel(0.3, 1, 0.5)).toBeCloseTo(0.5);
    expect(invertChannel(0.2, 0.5, 1)).toBeCloseTo(0.3);
    expect(invertChannel(0, 0, 1)).toBe(0);
  });
});

describe("new post registrations", () => {
  it("registers the five passes as stateless pass kinds with the spec defaults", () => {
    for (const t of ["punch", "flash", "blurpulse", "exposure", "invert"] as const) {
      const d = postDef(t);
      expect(d?.kind).toBe("pass");
      expect(d?.stateful).toBeFalsy();
      expect(d?.params.amount).toBeDefined();
    }
    expect(postDef("punch")?.params.zoom).toMatchObject({ min: 0, max: 0.6, default: 0.15 });
    expect(postDef("flash")?.params.color).toMatchObject({ kind: "color", default: "#ffffff" });
    expect(postDef("flash")?.params.mode).toMatchObject({ options: ["add", "screen"], default: "add" });
    expect(postDef("exposure")?.params.amount).toMatchObject({ min: -1, max: 1, default: 0 });
    expect(postDef("blurpulse")?.params.radius).toMatchObject({ max: 0.05, default: 0.02 });
  });
});
