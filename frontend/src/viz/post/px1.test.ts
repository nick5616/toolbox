import { describe, expect, it } from "vitest";
import {
  chromaticPx,
  flashLevel,
  foldAngle,
  frameDecay,
  glitchBell,
  glitchStep,
  glitchStrength,
  hash01,
  shakeCover,
  shakeOffset,
  sweepCentre,
  zoomPulseScale,
} from "./px1math";

describe("shake", () => {
  it("is deterministic and bounded to 2% of the short side", () => {
    const short = 720;
    for (let t = 0; t < 20000; t += 37) {
      const [x, y] = shakeOffset(t, 7, 1, short, 1);
      expect(Math.abs(x)).toBeLessThanOrEqual(0.02 * short + 1e-9);
      expect(Math.abs(y)).toBeLessThanOrEqual(0.02 * short + 1e-9);
      expect(shakeOffset(t, 7, 1, short, 1)).toEqual([x, y]);
    }
  });
  it("is still without kick or amount", () => {
    expect(shakeOffset(1234, 1, 0, 720, 1).map(Math.abs)).toEqual([0, 0]);
    expect(shakeOffset(1234, 1, 1, 720, 0).map(Math.abs)).toEqual([0, 0]);
  });
  it("covers the exposed border", () => {
    expect(shakeCover(0, 0, 1280, 720)).toBe(1);
    expect(shakeCover(14, 0, 1280, 720)).toBeGreaterThan(1);
  });
});

describe("zoom pulse and chromatic", () => {
  it("zooms only inward and scales with amount", () => {
    expect(zoomPulseScale(0, 1)).toBe(1);
    expect(zoomPulseScale(1, 0)).toBe(1);
    expect(zoomPulseScale(1, 1)).toBeCloseTo(1.06);
    expect(zoomPulseScale(5, 9)).toBeCloseTo(1.06);
  });
  it("keeps chromatic aberration to a few pixels", () => {
    expect(chromaticPx(4, 1, 720)).toBeCloseTo(4);
    expect(chromaticPx(4, 0, 720)).toBeCloseTo(1);
    expect(chromaticPx(4, 1, 1440)).toBeCloseTo(8);
  });
});

describe("feedback decay", () => {
  it("is frame-rate independent", () => {
    const at60 = Math.pow(frameDecay(0.8, 1000 / 60), 60);
    const at30 = Math.pow(frameDecay(0.8, 1000 / 30), 30);
    expect(at30).toBeCloseTo(at60, 5);
  });
  it("never exceeds 1", () => {
    expect(frameDecay(5, 16)).toBeLessThan(1);
  });
});

describe("mirror fold", () => {
  it("maps every angle into the first wedge", () => {
    const seg = (Math.PI * 2) / 6;
    for (let a = -10; a < 10; a += 0.07) {
      const f = foldAngle(a, 6);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(seg + 1e-9);
    }
  });
  it("is mirror symmetric", () => {
    expect(foldAngle(0.3, 8)).toBeCloseTo(foldAngle(-0.3, 8));
  });
});

describe("glitch", () => {
  it("is silent without a drop and ramps up", () => {
    expect(glitchStrength(0.05, 1)).toBe(0);
    expect(glitchStrength(1, 1)).toBeCloseTo(1);
    expect(glitchStrength(1, 0.5)).toBeCloseTo(0.5);
  });
  it("steps at 30 per second and hashes into 0..1", () => {
    expect(glitchStep(0)).toBe(0);
    expect(glitchStep(1000)).toBe(30);
    for (let i = 0; i < 1000; i++) {
      const h = hash01(i);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
    expect(hash01(42)).toBe(hash01(42));
  });
});

describe("transition curves", () => {
  it("flash starts bright and decays to nothing", () => {
    expect(flashLevel(0)).toBeGreaterThan(1);
    expect(flashLevel(1)).toBe(0);
    expect(flashLevel(0.3)).toBeGreaterThan(flashLevel(0.6));
  });
  it("sweep starts and ends off screen, left to right", () => {
    expect(sweepCentre(0, 0.2)).toBeCloseTo(-0.2);
    expect(sweepCentre(1, 0.2)).toBeCloseTo(1.2);
    expect(sweepCentre(0.5, 0.2)).toBeCloseTo(0.5);
  });
  it("glitch bell peaks in the middle", () => {
    expect(glitchBell(0)).toBe(0);
    expect(glitchBell(1)).toBe(0);
    expect(glitchBell(0.5)).toBe(1);
  });
});
