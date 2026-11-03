import { describe, expect, it } from "vitest";
import {
  TAU,
  bulgeFactor,
  bulgeMap,
  dirBlurOffsets,
  glowBright,
  glowLevelSizes,
  glowLevelWeights,
  hash21,
  kaleidoAngle,
  mirrorFold,
  shockDisp,
  shockRadius,
  shockRing,
  sliceBucket,
  sliceShift,
  swingMap,
  twirlAngle,
  twirlMap,
  waveOffset,
  zoomBlurTaps,
} from "./fx1math";
import { postDef } from "./index";
import type { PostType } from "../types";

type Spec = Record<string, [number, number, number] | string | boolean | string[]>;

const EXPECTED: Record<string, Spec> = {
  zoomblur: { amount: [0, 1, 0], cx: [0, 1, 0.5], cy: [0, 1, 0.5] },
  dirblur: { amount: [0, 1, 0], angle: [-180, 180, 0] },
  glow: { amount: [0, 3, 0], threshold: [0, 2, 0.6], radius: [0, 1, 0.5], tint: "#ffffff" },
  swing: { rotX: [-70, 70, 0], rotY: [-70, 70, 0], persp: [0, 1, 0.5], mirror: true },
  twirl: { amount: [-1, 1, 0], radius: [0, 1, 0.5], cx: [0, 1, 0.5], cy: [0, 1, 0.5] },
  wave: { amount: [0, 1, 0], freq: [1, 40, 8], speed: [0, 8, 1], dir: ["horizontal", "vertical"] },
  bulge: { amount: [-1, 1, 0], radius: [0, 1, 0.5], cx: [0, 1, 0.5], cy: [0, 1, 0.5] },
  shockwave: { amount: [0, 1, 0], width: [0.01, 0.3, 0.08], strength: [0, 1, 0.5], cx: [0, 1, 0.5], cy: [0, 1, 0.5] },
  kaleido: { amount: [0, 1, 0], segments: [2, 16, 6], rotation: [-180, 180, 0], zoom: [0.5, 2, 1] },
  slice: { amount: [0, 1, 0], bands: [2, 64, 12], rgb: [0, 1, 0.3] },
};

describe("FX1 registration (SPEC 23.4)", () => {
  for (const [id, params] of Object.entries(EXPECTED)) {
    it(`${id} is a registered pass with the specified params`, () => {
      const def = postDef(id as PostType);
      expect(def, id).toBeDefined();
      expect(def?.kind).toBe("pass");
      expect(def?.create).toBeTypeOf("function");
      expect(Object.keys(def?.params ?? {}).sort()).toEqual(Object.keys(params).sort());
      for (const [name, want] of Object.entries(params)) {
        const p = def?.params[name];
        if (Array.isArray(want) && want.length === 3 && typeof want[0] === "number") {
          expect(p).toMatchObject({ kind: "number", min: want[0], max: want[1], default: want[2] });
        } else if (Array.isArray(want)) {
          expect(p).toMatchObject({ kind: "enum", options: want, default: want[0] });
        } else if (typeof want === "boolean") {
          expect(p).toMatchObject({ kind: "bool", default: want });
        } else {
          expect(p).toMatchObject({ kind: "color", default: want });
        }
      }
    });
  }
  it("labels", () => {
    expect(postDef("zoomblur")?.label).toBe("Zoom blur");
    expect(postDef("dirblur")?.label).toBe("Motion blur");
    expect(postDef("glow")?.label).toBe("Deep glow");
    expect(postDef("swing")?.label).toBe("3D swing");
    expect(postDef("bulge")?.label).toBe("Bulge / pinch");
    expect(postDef("kaleido")?.label).toBe("Kaleidoscope");
    expect(postDef("slice")?.label).toBe("Slice shift");
  });
});

describe("mirrorFold", () => {
  it("is identity inside 0..1 and reflects outside", () => {
    expect(mirrorFold(0.3)).toBeCloseTo(0.3);
    expect(mirrorFold(1.2)).toBeCloseTo(0.8);
    expect(mirrorFold(-0.2)).toBeCloseTo(0.2);
    expect(mirrorFold(2.3)).toBeCloseTo(0.3);
    for (let x = -3; x < 3; x += 0.137) {
      const m = mirrorFold(x);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(1);
    }
  });
});

describe("zoomblur / dirblur", () => {
  it("amount 0 samples the pixel itself 24 times", () => {
    const taps = zoomBlurTaps([0.2, 0.9], [0.5, 0.5], 0);
    expect(taps).toHaveLength(24);
    for (const t of taps) expect(t).toEqual([0.2, 0.9]);
    for (const o of dirBlurOffsets([1920, 1080], 0, 33)) expect(Math.abs(o[0]) + Math.abs(o[1])).toBe(0);
  });
  it("zoom taps converge on the centre, total length amount*0.35 of the distance", () => {
    const taps = zoomBlurTaps([1, 0.5], [0.5, 0.5], 1);
    expect(taps[0]).toEqual([1, 0.5]);
    expect(taps[23]?.[0]).toBeCloseTo(0.5 + 0.5 * 0.65);
    // the centre pixel never moves
    for (const t of zoomBlurTaps([0.5, 0.5], [0.5, 0.5], 1)) expect(t).toEqual([0.5, 0.5]);
  });
  it("motion blur is symmetric, along the angle, length amount*0.12 of the short side", () => {
    const o = dirBlurOffsets([1000, 500], 1, 0);
    expect(o).toHaveLength(24);
    expect(o[0]?.[0]).toBeCloseTo(-(0.12 * 500 * 0.5) / 1000);
    expect(o[23]?.[0]).toBeCloseTo((0.12 * 500 * 0.5) / 1000);
    expect((o[0]?.[0] ?? 0) + (o[23]?.[0] ?? 0)).toBeCloseTo(0);
    for (const v of o) expect(v[1]).toBeCloseTo(0);
    const up = dirBlurOffsets([1000, 500], 1, 90);
    for (const v of up) expect(v[0]).toBeCloseTo(0);
    expect((up[23]?.[1] ?? 0) - (up[0]?.[1] ?? 0)).toBeCloseTo((0.12 * 500) / 500);
  });
});

describe("glow", () => {
  it("bright pass is zero at or below the threshold and keeps colour ratios", () => {
    expect(glowBright(0.5, 0.6)).toBe(0);
    expect(glowBright(0.6, 0.6)).toBe(0);
    expect(glowBright(0, 0.6)).toBe(0);
    expect(glowBright(2, 0.6) * 2).toBeCloseTo(1.4);
    expect(glowBright(1, 0)).toBe(1);
  });
  it("level weights sum to 1 and shift towards coarse levels with the radius", () => {
    for (const r of [0, 0.25, 0.5, 1]) {
      const w = glowLevelWeights(r);
      expect(w).toHaveLength(5);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    }
    const small = glowLevelWeights(0);
    const big = glowLevelWeights(1);
    expect(small[0] ?? 0).toBeGreaterThan(big[0] ?? 1);
    expect(big[4] ?? 0).toBeGreaterThan(small[4] ?? 1);
  });
  it("pyramid is half resolution first and never below 1 px", () => {
    expect(glowLevelSizes(1920, 1080)).toEqual([[960, 540], [480, 270], [240, 135], [120, 67], [60, 33]]);
    for (const s of glowLevelSizes(7, 3)) {
      expect(s[0]).toBeGreaterThanOrEqual(1);
      expect(s[1]).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("swing", () => {
  it("is identity at rotX = rotY = 0 for any perspective", () => {
    for (const persp of [0, 0.5, 1]) {
      for (const p of [[0.3, -0.2], [-0.8, 0.45], [0, 0]] as [number, number][]) {
        const q = swingMap(p, 0, 0, persp);
        expect(q?.[0]).toBeCloseTo(p[0]);
        expect(q?.[1]).toBeCloseTo(p[1]);
      }
    }
  });
  it("keeps the centre fixed and rotating about Y foreshortens x", () => {
    const c = swingMap([0, 0], 40, -30, 0.5);
    expect(c?.[0]).toBeCloseTo(0);
    expect(c?.[1]).toBeCloseTo(0);
    // Orthographic Y rotation: the visible x maps to source x / cos(b).
    const q = swingMap([0.2, 0], 0, 60, 0);
    expect(q?.[0]).toBeCloseTo(0.2 / Math.cos(Math.PI / 3));
    expect(q?.[1]).toBeCloseTo(0);
  });
  it("is mirror-symmetric in rotY at the vertical axis", () => {
    const a = swingMap([0.3, 0.1], 0, 35, 0.5);
    const b = swingMap([-0.3, 0.1], 0, -35, 0.5);
    expect(a?.[0]).toBeCloseTo(-(b?.[0] ?? 0));
    expect(a?.[1]).toBeCloseTo(b?.[1] ?? 0);
  });
  it("returns null only where the plane passes behind the camera", () => {
    expect(swingMap([0.5, 0.3], 40, 40, 1)).not.toBeNull();
    expect(swingMap([50, 0], 0, 70, 1)).toBeNull();
  });
});

describe("twirl", () => {
  it("angle at r=0 is amount*2pi and 0 at r>=R", () => {
    expect(twirlAngle(0, 0.5, 1)).toBeCloseTo(TAU);
    expect(twirlAngle(0, 0.5, -0.25)).toBeCloseTo(-TAU / 4);
    expect(twirlAngle(0.5, 0.5, 1)).toBe(0);
    expect(twirlAngle(0.9, 0.5, 1)).toBe(0);
    expect(twirlAngle(0.25, 0.5, 1)).toBeCloseTo(TAU * 0.25);
  });
  it("is identity at amount 0 and outside the radius, and preserves radius", () => {
    const p: [number, number] = [0.2, 0.1];
    expect(twirlMap(p, 0.5, 0)).toEqual(p);
    const out: [number, number] = [0.7, 0.2];
    expect(twirlMap(out, 0.5, 1)).toEqual(out);
    const q = twirlMap(p, 0.5, 0.6);
    expect(Math.hypot(q[0], q[1])).toBeCloseTo(Math.hypot(p[0], p[1]));
  });
});

describe("wave", () => {
  it("is zero at amount 0, bounded by amount*0.05, deterministic in time", () => {
    expect(waveOffset(0.37, 0, 8, 1, 1.2)).toBe(0);
    let max = 0;
    for (let x = 0; x < 1; x += 0.01) max = Math.max(max, Math.abs(waveOffset(x, 0.8, 8, 1, 0.3)));
    expect(max).toBeLessThanOrEqual(0.8 * 0.05 + 1e-12);
    expect(max).toBeGreaterThan(0.8 * 0.05 * 0.95);
    expect(waveOffset(0.2, 1, 8, 2, 0.5)).toBe(waveOffset(0.2, 1, 8, 2, 0.5));
  });
  it("speed 0 freezes it and one cycle of time repeats it", () => {
    expect(waveOffset(0.3, 1, 8, 0, 0)).toBeCloseTo(waveOffset(0.3, 1, 8, 0, 9));
    expect(waveOffset(0.3, 1, 8, 2, 0.5)).toBeCloseTo(waveOffset(0.3, 1, 8, 2, 1.0));
  });
});

describe("bulge", () => {
  it("is identity at amount 0 and at or beyond the radius", () => {
    expect(bulgeFactor(0.3, 0)).toBe(1);
    expect(bulgeFactor(1, 1)).toBe(1);
    expect(bulgeFactor(2, -1)).toBe(1);
    const p: [number, number] = [0.1, -0.2];
    expect(bulgeMap(p, 0.5, 0)).toEqual(p);
  });
  it("positive magnifies (samples closer to the centre), negative pinches", () => {
    expect(bulgeFactor(0, 1)).toBeCloseTo(0.2);
    expect(bulgeFactor(0, -1)).toBeCloseTo(1.8);
    expect(bulgeFactor(0.5, 0.5)).toBeLessThan(1);
    expect(bulgeFactor(0.5, -0.5)).toBeGreaterThan(1);
  });
});

describe("shockwave", () => {
  const hd = 0.5 * Math.hypot(16 / 9, 1);
  it("ring radius from amount: starts beyond the corner, shrinks to 1.2 half-diagonals * (1 - amount)", () => {
    expect(shockRadius(0, hd)).toBeCloseTo(1.2 * hd);
    expect(shockRadius(0.5, hd)).toBeCloseTo(0.6 * hd);
    expect(shockRadius(1, hd)).toBe(0);
  });
  it("displacement is zero at amount 0, peaks on the ring and vanishes beyond the width", () => {
    expect(shockDisp(0.7, 0, 0.08, 0.5, hd)).toBe(0);
    const amount = 0.4;
    const r0 = shockRadius(amount, hd);
    const peak = shockDisp(r0, amount, 0.08, 1, hd);
    expect(peak).toBeGreaterThan(0);
    expect(shockDisp(r0 + 0.5 * 0.08 * hd, amount, 0.08, 1, hd)).toBeLessThan(peak);
    expect(shockDisp(r0 + 0.08 * hd + 1e-6, amount, 0.08, 1, hd)).toBe(0);
    expect(shockDisp(r0 - 0.08 * hd - 1e-6, amount, 0.08, 1, hd)).toBe(0);
    expect(shockDisp(r0, amount, 0.08, 0, hd)).toBe(0);
  });
  it("ring profile is a smooth bump", () => {
    expect(shockRing(0, 0.1)).toBe(1);
    expect(shockRing(0.1, 0.1)).toBe(0);
    expect(shockRing(0.05, 0.1)).toBeCloseTo(0.5);
  });
});

describe("kaleido", () => {
  it("maps every angle into one segment, for all segment counts", () => {
    for (const n of [2, 3, 6, 11, 16]) {
      const seg = TAU / n;
      for (let a = -7; a < 7; a += 0.0731) {
        const m = kaleidoAngle(a, n, 0.4);
        expect(m).toBeGreaterThanOrEqual(-1e-9);
        expect(m).toBeLessThanOrEqual(seg + 1e-9);
      }
    }
  });
  it("mirrors about segment boundaries", () => {
    const n = 6;
    const seg = TAU / n;
    expect(kaleidoAngle(0.2, n, 0)).toBeCloseTo(0.2);
    expect(kaleidoAngle(seg + 0.2, n, 0)).toBeCloseTo(seg - 0.2);
    expect(kaleidoAngle(2 * seg + 0.2, n, 0)).toBeCloseTo(0.2);
  });
});

describe("slice", () => {
  it("is deterministic per (band, bucket, seed)", () => {
    expect(sliceShift(3, 1000, 42, 0.8, 0.3)).toEqual(sliceShift(3, 1000, 42, 0.8, 0.3));
    expect(hash21(3, 15)).toBe(hash21(3, 15));
  });
  it("is constant within a 66 ms bucket and changes between buckets", () => {
    const t0 = 66 * 20;
    expect(sliceBucket(t0)).toBe(20);
    expect(sliceBucket(t0 + 65)).toBe(20);
    expect(sliceBucket(t0 + 66)).toBe(21);
    expect(sliceShift(4, t0 + 1, 7, 1, 0.3)).toEqual(sliceShift(4, t0 + 65, 7, 1, 0.3));
    let changed = 0;
    for (let b = 0; b < 12; b++) {
      if (sliceShift(b, t0, 7, 1, 0.3).shift !== sliceShift(b, t0 + 66, 7, 1, 0.3).shift) changed++;
    }
    expect(changed).toBeGreaterThanOrEqual(11);
  });
  it("depends on the seed and band", () => {
    expect(sliceShift(2, 500, 1, 1, 0.3).shift).not.toBe(sliceShift(2, 500, 2, 1, 0.3).shift);
    expect(sliceShift(2, 500, 1, 1, 0.3).shift).not.toBe(sliceShift(3, 500, 1, 1, 0.3).shift);
  });
  it("amount 0 shifts and splits nothing; shift is bounded by amount*0.25", () => {
    const z = sliceShift(5, 900, 3, 0, 1);
    expect(Math.abs(z.shift)).toBe(0);
    expect(Math.abs(z.split)).toBe(0);
    for (let b = 0; b < 64; b++) {
      const s = sliceShift(b, 1234, 9, 0.6, 1);
      expect(Math.abs(s.shift)).toBeLessThanOrEqual(0.6 * 0.25 + 1e-12);
      expect(Math.abs(s.split)).toBeLessThanOrEqual(0.6 * 0.04 + 1e-12);
    }
  });
  it("rgb 0 gives no split", () => {
    expect(Math.abs(sliceShift(2, 500, 1, 1, 0).split)).toBe(0);
  });
});
