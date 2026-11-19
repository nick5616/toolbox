import { describe, expect, it } from "vitest";
import { CHANMIX_PRESETS } from "./ops";
import {
  applyRow, bandWeights, curve5, defaultPixel, driftOf, evalRows, hsvToRgb, labBandStats, labToRgb, opColor, pulseOf, regionWeight, rgbToHsv, rgbToLab, smoothstep, toLin, toSrgb,
  type PixelCtx, type Vec3,
} from "./math";
import { packOp, packTable, parseTable, KIND_CODE, type TableOp } from "./pack";
import { TEST_COLORS } from "./flash";
import type { GradeParam, Region } from "./types";

const near = (a: readonly number[], b: readonly number[], tol = 1 / 255) => a.forEach((v, i) => expect(Math.abs(v - (b[i] as number)), `[${i}] ${a} vs ${b}`).toBeLessThanOrEqual(tol));

/** One op through the packed row, at amount 1, region all. */
function run(kind: TableOp["kind"], params: Record<string, GradeParam>, c: Vec3, px: Partial<PixelCtx> = {}, over: Partial<TableOp> = {}): Vec3 {
  const row = packOp({ kind, amount: 1, region: { kind: "all" }, params, ...over });
  return applyRow(row, 0, c, c, defaultPixel(px), 0);
}
const grey = (v: number): Vec3 => [v, v, v];

describe("colour spaces", () => {
  it("round-trips sRGB through linear, HSV and Lab", () => {
    for (const c of TEST_COLORS) {
      near(c.map((v) => toSrgb(toLin(v))), c, 1e-6);
      const [h, s, v] = rgbToHsv(c);
      near(hsvToRgb(h, s, v), c, 1e-6);
      near(labToRgb(rgbToLab(c)), c, 1.5 / 255);
    }
  });

  it("has the Lab anchors: white is L 100, black is 0", () => {
    near(rgbToLab([1, 1, 1]), [100, 0, 0], 0.05);
    near(rgbToLab([0, 0, 0]), [0, 0, 0], 0.05);
  });

  it("band weights always sum to 1 and follow lightness", () => {
    for (let l = 0; l <= 1.0001; l += 0.05) expect(bandWeights(l).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(bandWeights(0.05)[0]).toBe(1);
    expect(bandWeights(0.5)[1]).toBe(1);
    expect(bandWeights(0.95)[2]).toBe(1);
  });

  it("measures band stats of a flat picture", () => {
    const rgba = new Uint8ClampedArray(4 * 16).fill(255);
    const s = labBandStats(rgba);
    expect(s).toHaveLength(18);
    expect(s[12]).toBeCloseTo(100, 0); // highlights mean L
    expect(s[15]).toBeCloseTo(0, 3); // and no spread
  });
});

describe("curves", () => {
  it("is the identity through the identity points and hits its knots", () => {
    for (let x = 0; x <= 1; x += 0.05) expect(curve5([0, 0.25, 0.5, 0.75, 1], x)).toBeCloseTo(x, 9);
    const y = [0.1, 0.35, 0.5, 0.65, 0.9];
    y.forEach((v, i) => expect(curve5(y, i / 4)).toBeCloseTo(v, 9));
  });

  it("is monotone for monotone knots (no overshoot)", () => {
    const y = [0, 0.05, 0.6, 0.62, 1];
    let prev = -1;
    for (let x = 0; x <= 1; x += 0.01) {
      const v = curve5(y, x);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });
});

describe("op reference functions", () => {
  it("balance: exposure is in linear light, contrast pivots, saturation 0 is grey", () => {
    near(run("balance", { exposure: 1 }, grey(0.5)), grey(toSrgb(toLin(0.5) * 2)), 1e-6);
    near(run("balance", { contrast: 2 }, grey(0.6)), grey(0.7), 1e-6);
    near(run("balance", { saturation: 0 }, [0.8, 0.2, 0.2]), grey(0.2126 * 0.8 + 0.7152 * 0.2 + 0.0722 * 0.2), 1e-6);
    const warm = run("balance", { temp: 1 }, grey(0.5));
    expect(warm[0]).toBeGreaterThan(warm[2]);
  });

  it("wheels: gain scales, lift lifts the shadows, gamma brightens the mids", () => {
    near(run("wheels", { gain: [0.5, 0.5, 0.5], lift: [0, 0, 0], gamma: [0, 0, 0] }, grey(0.4)), grey(0.52), 1e-6);
    expect(run("wheels", { lift: [0.5, 0.5, 0.5] }, grey(0.1))[0]).toBeGreaterThan(0.2);
    expect(run("wheels", { gamma: [1, 1, 1] }, grey(0.5))[0]).toBeGreaterThan(0.6);
  });

  it("curves: applies master after the channel curve", () => {
    const out = run("curves", { master: [0.1, 0.35, 0.5, 0.65, 0.9], r: [0, 0.25, 0.5, 0.75, 1] }, [0, 0.5, 1]);
    near(out, [0.1, 0.5, 0.9], 1e-6);
  });

  it("hsl: a red hue shift of 60 degrees makes red yellow; greys don't move", () => {
    const hue = [60, 0, 0, 0, 0, 0];
    near(run("hsl", { hue }, [1, 0, 0]), [1, 1, 0], 1e-6);
    near(run("hsl", { hue }, grey(0.5)), grey(0.5), 1e-6);
    expect(run("hsl", { sat: [-1, 0, 0, 0, 0, 0] }, [0.8, 0.2, 0.2])[1]).toBeGreaterThan(0.2);
  });

  it("split: shadows take the shadow colour's chroma, highlights the highlight's", () => {
    const params = { shadow: "#0000ff", highlight: "#ff0000", balance: 0 };
    const dark = run("split", params, grey(0.1));
    const light = run("split", params, grey(0.9));
    expect(dark[2]).toBeGreaterThan(dark[0]);
    expect(light[0]).toBeGreaterThan(light[2]);
  });

  it("gradmap: luma, depth and hue sources; replace, color and soft blends", () => {
    const stops = "#000000@0.00,#ffffff@1.00";
    near(run("gradmap", { stops, source: "luma", blend: "replace" }, [0.5, 0.5, 0.5]), grey(0.5), 1e-6);
    near(run("gradmap", { stops, source: "depth", blend: "replace" }, [1, 0, 0], { depth: 0.25 }), grey(0.25), 1e-6);
    near(run("gradmap", { stops: "#000000@0.00,#ff0000@1.00", source: "hue", blend: "replace" }, [0, 1, 0]), [1 / 3, 0, 0], 1e-6);
    // "color" keeps the picture's brightness
    const c: Vec3 = [0.6, 0.3, 0.2];
    const out = run("gradmap", { stops: "#0000ff@0.00,#00ff00@1.00", source: "depth", blend: "color" }, c, { depth: 0.5 });
    expect(0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2]).toBeCloseTo(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], 1);
    near(run("gradmap", { stops, source: "depth", blend: "soft" }, [1, 1, 1], { depth: 0 }), grey(0.5), 1e-6);
  });

  it("gradmap: three stops interpolate piecewise and clamp beyond the ends", () => {
    const stops = "#ff0000@0.20,#00ff00@0.50,#0000ff@0.80";
    const at = (t: number) => run("gradmap", { stops, source: "depth", blend: "replace" }, grey(0.5), { depth: t });
    near(at(0), [1, 0, 0], 1e-6);
    near(at(0.35), [0.5, 0.5, 0], 1e-6);
    near(at(0.65), [0, 0.5, 0.5], 1e-6);
    near(at(1), [0, 0, 1], 1e-6);
  });

  it("gradmap drift moves along the gradient and mirrors at the ends", () => {
    const stops = "#000000@0.00,#ffffff@1.00";
    near(run("gradmap", { stops, source: "depth", blend: "replace", drift: 0.25 }, grey(0.5), { depth: 0.5 }), grey(0.75), 1e-6);
    near(run("gradmap", { stops, source: "depth", blend: "replace", drift: 0.75 }, grey(0.5), { depth: 0.5 }), grey(0.75), 1e-6); // 1.25 mirrors to 0.75
  });

  it("chanmix: the BRG preset rotates the channels, aerochrome turns green magenta-red", () => {
    near(run("chanmix", { matrix: CHANMIX_PRESETS.brg as number[] }, [1, 0, 0]), [0, 1, 0], 1e-6);
    near(run("chanmix", { matrix: CHANMIX_PRESETS.identity as number[] }, [0.2, 0.5, 0.9]), [0.2, 0.5, 0.9], 1e-6);
    const foliage = run("chanmix", { matrix: CHANMIX_PRESETS.aerochrome as number[] }, [0.2, 0.6, 0.1]);
    expect(foliage[0]).toBeGreaterThan(foliage[1] * 3);
    expect(foliage[2]).toBeGreaterThan(foliage[1]);
  });

  it("solarize, posterize, invert", () => {
    near(run("solarize", { threshold: 0.5, mix: 1 }, [0.8, 0.3, 0.5]), [0.2, 0.3, 0.5], 0.02);
    near(run("solarize", { threshold: 0.5, mix: 0 }, [0.8, 0.3, 0.5]), [0.8, 0.3, 0.5], 1e-6);
    near(run("posterize", { levels: 2 }, [0.6, 0.4, 0.99]), [1, 0, 1], 1e-6);
    near(run("posterize", { levels: 4 }, grey(0.5)), grey(2 / 3), 1e-6);
    near(run("invert", { r: true, g: false, b: false }, [0.2, 0.3, 0.4]), [0.8, 0.3, 0.4], 1e-6);
  });

  it("huecycle: half a turn flips red to cyan; zero cycles and phase is the identity", () => {
    const out = run("huecycle", { by: "luma", cycles: 0, phase: 0.5 }, [1, 0, 0]);
    expect(out[0]).toBeLessThan(0.01);
    expect(out[1]).toBeCloseTo(2 / 3, 6);
    near(run("huecycle", { by: "luma", cycles: 0, phase: 0 }, [0.3, 0.6, 0.2]), [0.3, 0.6, 0.2], 1e-6);
    // by radius: the centre is a no-turn, a corner is a full cycle at cycles 1 → both identity-ish; mid-radius turns
    near(run("huecycle", { by: "radius", cycles: 1, phase: 0 }, [0.3, 0.6, 0.2], { x: 0.5, y: 0.5 }), [0.3, 0.6, 0.2], 1e-6);
    const mid = run("huecycle", { by: "radius", cycles: 1, phase: 0 }, [0.3, 0.6, 0.2], { x: 0.85, y: 0.5 });
    expect(Math.abs(mid[0] - 0.3)).toBeGreaterThan(0.02);
  });

  it("transfer: identical source and reference stats leave the picture alone; a brighter reference lifts the mids", () => {
    for (const c of TEST_COLORS) near(run("transfer", {}, c), c, 2 / 255);
    const neutral = [22, 0, 0, 12, 6, 6, 52, 0, 0, 16, 8, 8, 82, 0, 0, 12, 6, 6];
    const bright = neutral.slice();
    bright[6] = 72; // mids mean L
    const out = run("transfer", { stats: bright }, grey(0.5));
    expect(out[0]).toBeGreaterThan(0.55);
    // a wider reference spread pushes a shadow below the band mean further down
    const wide = neutral.slice();
    wide[3] = 24; // shadows sd L ×2
    expect(rgbToLab(run("transfer", { stats: wide }, grey(0.2)))[0]).toBeLessThan(rgbToLab(grey(0.2))[0]);
  });

  it("bleach: greys stay put, colours lose some chroma", () => {
    near(run("bleach", {}, grey(0.5)), grey(0.5), 1e-6);
    const c: Vec3 = [0.8, 0.3, 0.2];
    const o = run("bleach", {}, c);
    expect(Math.max(...o) - Math.min(...o)).toBeLessThan(Math.max(...c) - Math.min(...c) + 0.2);
  });

  it("vignette: the centre stays, the corners darken; grain is deterministic per cell and frame", () => {
    const c = grey(0.6);
    near(run("vignette", { size: 0.5, softness: 0.5, roundness: 0.5 }, c, { x: 0.5, y: 0.5 }), c, 1e-9);
    expect(run("vignette", { size: 0.5, softness: 0.5, roundness: 0.5 }, c, { x: 0.02, y: 0.02 })[0]).toBeLessThan(0.3);
    const a = run("grain", { size: 1, colored: 0.5 }, c, { x: 0.3, y: 0.3, t: 1 });
    expect(run("grain", { size: 1, colored: 0.5 }, c, { x: 0.3, y: 0.3, t: 1 })).toEqual(a);
    expect(run("grain", { size: 1, colored: 0.5 }, c, { x: 0.3, y: 0.3, t: 2 })).not.toEqual(a);
    expect(run("grain", { size: 1, colored: 0 }, c, { x: 0.3, y: 0.3, t: 1 })[0]).toBeCloseTo(run("grain", { size: 1, colored: 0 }, c, { x: 0.3, y: 0.3, t: 1 })[2], 9);
  });

  it("every op keeps its output in 0..1 over the test colours", () => {
    const kinds = Object.keys(KIND_CODE).filter((k) => k !== "gate") as TableOp["kind"][];
    for (const k of kinds) {
      for (const c of TEST_COLORS) {
        const o = run(k, {}, c, { x: 0.2, y: 0.9, depth: 0.7 });
        o.forEach((v) => {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
          expect(Number.isFinite(v)).toBe(true);
        });
      }
    }
  });

  it("the default params of balance, wheels, curves, hsl, chanmix leave colours unchanged", () => {
    for (const k of ["balance", "wheels", "curves", "hsl", "chanmix"] as const) for (const c of TEST_COLORS) near(run(k, {}, c), c, 1 / 255);
  });
});

describe("amount, regions and pulses", () => {
  const params = { stops: "#ff0000@0.00,#ff0000@1.00", source: "luma", blend: "replace" };
  const red: Vec3 = [1, 0, 0];

  it("blends as mix(prev, op(prev), amount)", () => {
    near(run("gradmap", params, grey(0.5), {}, { amount: 0.5 }), [0.75, 0.25, 0.25], 1e-9);
    near(run("gradmap", params, grey(0.5), {}, { amount: 0 }), grey(0.5), 1e-9);
  });

  const rw = (region: Region, l0: number, px: Partial<PixelCtx> = {}) => {
    const row = packOp({ kind: "gate", amount: 1, region, params: {} });
    return regionWeight(row, 0, l0, defaultPixel(px));
  };

  it("tonal regions follow the original luma", () => {
    expect(rw({ kind: "highlights", soft: 0.5 }, 0.95)).toBeCloseTo(1, 3);
    expect(rw({ kind: "highlights", soft: 0.5 }, 0.1)).toBeCloseTo(0, 3);
    expect(rw({ kind: "shadows", soft: 0.5 }, 0.05)).toBeCloseTo(1, 3);
    expect(rw({ kind: "midtones", soft: 0.5 }, 0.5)).toBeGreaterThan(0.6);
    expect(rw({ kind: "midtones", soft: 0.5 }, 0.02)).toBeLessThan(0.1);
  });

  it("subject, background and people read the matte; with no map (subject 1) the subject is everything", () => {
    expect(rw({ kind: "subject", feather: 0.2 }, 0.5, { subject: 1 })).toBe(1);
    expect(rw({ kind: "subject", feather: 0.2 }, 0.5, { subject: 0 })).toBe(0);
    expect(rw({ kind: "background", feather: 0.2 }, 0.5, { subject: 0 })).toBe(1);
    expect(rw({ kind: "background", feather: 0.2 }, 0.5, { subject: 1 })).toBe(0);
    expect(rw({ kind: "people", feather: 0.2 }, 0.5, { people: 0.9 })).toBe(1);
    expect(rw({ kind: "subject", feather: 0.2, invert: true }, 0.5, { subject: 1 })).toBe(0);
    const soft = rw({ kind: "subject", feather: 1 }, 0.5, { subject: 0.6 });
    expect(soft).toBeGreaterThan(0.5);
    expect(soft).toBeLessThan(1);
  });

  it("near and far split on the depth", () => {
    expect(rw({ kind: "near", split: 0.5, feather: 0.1 }, 0.5, { depth: 0.9 })).toBe(1);
    expect(rw({ kind: "near", split: 0.5, feather: 0.1 }, 0.5, { depth: 0.1 })).toBe(0);
    expect(rw({ kind: "far", split: 0.5, feather: 0.1 }, 0.5, { depth: 0.1 })).toBe(1);
    expect(rw({ kind: "near", split: 0.5, feather: 0.5 }, 0.5, { depth: 0.5 })).toBeCloseTo(0.5, 6);
  });

  it("a region gates an op: red only on the near half", () => {
    const op = (depth: number) => run("gradmap", params, grey(0.5), { depth }, { region: { kind: "near", split: 0.5, feather: 0.1 } });
    near(op(0.9), red, 1e-9);
    near(op(0.1), grey(0.5), 1e-9);
  });

  it("sine pulses start at full strength, dip by their depth, and beat pulses follow the drive", () => {
    const row = packOp({ kind: "bleach", amount: 1, region: { kind: "all" }, params: {}, anim: { wave: "sine", speed: 6, depth: 0.5 } });
    expect(pulseOf(row, 0, defaultPixel({ t: 0 }), 0)).toBeCloseTo(1, 9);
    expect(pulseOf(row, 0, defaultPixel({ t: 10 / 6 / 2 }), 0)).toBeCloseTo(0.5, 9); // half a cycle
    const saw = packOp({ kind: "bleach", amount: 1, region: { kind: "all" }, params: {}, anim: { wave: "saw", speed: 6, depth: 1 } });
    expect(pulseOf(saw, 0, defaultPixel({ t: 0 }), 0)).toBeCloseTo(1, 9);
    expect(pulseOf(saw, 0, defaultPixel({ t: 0.5 * (10 / 6) }), 0)).toBeCloseTo(0.5, 9);
    const ext = packOp({ kind: "bleach", amount: 1, region: { kind: "all" }, params: {}, anim: { wave: "ext", speed: 1, depth: 1 } });
    const drive = new Array<number>(16).fill(1);
    drive[0] = 0.25;
    expect(pulseOf(ext, 0, defaultPixel({ drive }), 0)).toBeCloseTo(0.25, 9);
    expect(pulseOf(ext, 0, defaultPixel({ drive }), 1)).toBeCloseTo(1, 9);
  });

  it("drift kinds move instead of pulsing", () => {
    const row = packOp({ kind: "huecycle", amount: 1, region: { kind: "all" }, params: {}, anim: { wave: "sine", speed: 3, depth: 1 } });
    expect(pulseOf(row, 0, defaultPixel({ t: 1 }), 0)).toBe(1);
    expect(driftOf(row, 0, defaultPixel({ t: 10 }), 0)).toBeCloseTo(3, 9);
    const ext = packOp({ kind: "gradmap", amount: 1, region: { kind: "all" }, params: {}, anim: { wave: "ext", speed: 1, depth: 1 } });
    expect(driftOf(ext, 0, defaultPixel({ drive: new Array<number>(16).fill(1) }), 0)).toBeCloseTo(0.25, 9);
  });

  it("evalRows runs the ops in order, from the chain's original colour for regions", () => {
    const t = packTable({
      ops: [
        { kind: "invert", amount: 1, region: { kind: "all" }, params: {} },
        { kind: "invert", amount: 1, region: { kind: "all" }, params: {} },
      ],
    });
    near(evalRows(t.data, t.count, [0.2, 0.4, 0.6]), [0.2, 0.4, 0.6], 1e-9);
    near(evalRows(t.data, 0, [0.2, 0.4, 0.6]), [0.2, 0.4, 0.6], 1e-9);
    const row = opColor(t.data, 0, [0.2, 0.4, 0.6], defaultPixel(), 0);
    near(row, [0.8, 0.6, 0.4], 1e-9);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
  });
});

describe("table packing", () => {
  it("packs an op into the documented row layout", () => {
    const row = packOp({ kind: "split", amount: 0.4, region: { kind: "subject", feather: 0.3, invert: true }, params: { shadow: "#ff0000", highlight: "#0000ff", balance: 0.5 }, anim: { wave: "sine", speed: 2, depth: 0.5 } });
    expect(Array.from(row.subarray(0, 12)).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([KIND_CODE.split, 0.4, 4, 1, 0.3, 0, 1, 2, 0.5, 0, 0, 0]);
    expect(Array.from(row.subarray(12, 16))).toEqual([1, 0, 0, 0.5]);
    expect(Array.from(row.subarray(16, 19))).toEqual([0, 0, 1]);
  });

  it("packs up to 16 ops and ignores the rest; parses the table param tolerantly", () => {
    const op: TableOp = { kind: "bleach", amount: 1, region: { kind: "all" }, params: {} };
    expect(packTable({ ops: Array.from({ length: 20 }, () => op) }).count).toBe(16);
    expect(parseTable("[]").ops).toEqual([]);
    expect(parseTable("{nope").ops).toEqual([]);
    expect(parseTable(JSON.stringify({ ops: [op, { kind: "teleport" }] })).ops).toHaveLength(1);
    expect(parseTable(undefined).ops).toEqual([]);
  });

  it("round-trips gradient stops, curves and the transfer stats", () => {
    const g = packOp({ kind: "gradmap", amount: 1, region: { kind: "all" }, params: { stops: "#ff0000@0.10,#00ff00@0.60,#0000ff@0.90", source: "hue", blend: "soft", drift: 0.5 } });
    expect(Array.from(g.subarray(12, 16))).toEqual([3, 2, 2, 0.5]);
    expect(Array.from(g.subarray(16, 20))).toEqual([1, 0, 0, Math.fround(0.1)]);
    expect(Array.from(g.subarray(24, 28))).toEqual([0, 0, 1, Math.fround(0.9)]);
    const stats = Array.from({ length: 18 }, (_, i) => i + 1);
    const t = packOp({ kind: "transfer", amount: 1, region: { kind: "all" }, params: { stats, src: stats.map((v) => -v) } });
    expect(Array.from(t.subarray(12, 30))).toEqual(stats.map((v) => -v));
    expect(Array.from(t.subarray(32, 50))).toEqual(stats);
  });
});
