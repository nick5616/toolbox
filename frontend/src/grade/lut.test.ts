import { describe, expect, it } from "vitest";
import { CHANMIX_PRESETS } from "./ops";
import { bakeLutCPU, latticeColor, latticeSize, LUT_SIZE, lutFromPixels, lutPlan } from "./lut";
import { builtInLook } from "./looks";
import { TEST_COLORS } from "./flash";
import { evalRows } from "./math";
import { packTable } from "./pack";
import type { GradeRecipe } from "./types";

const near = (a: readonly number[], b: readonly number[], tol: number) => a.forEach((v, i) => expect(Math.abs(v - (b[i] as number))).toBeLessThanOrEqual(tol));

describe("LUT lattice", () => {
  it("is 1089 × 33: x = r + 33·b, y = g", () => {
    expect(latticeSize()).toEqual({ w: 1089, h: 33 });
    expect(latticeColor(0, 0)).toEqual([0, 0, 0]);
    expect(latticeColor(32, 0)).toEqual([1, 0, 0]);
    expect(latticeColor(33, 0)).toEqual([0, 0, 1 / 32]);
    expect(latticeColor(1088, 32)).toEqual([1, 1, 1]);
    expect(latticeColor(5 + 33 * 7, 9)).toEqual([5 / 32, 9 / 32, 7 / 32]);
  });

  it("reads pixels back in .cube order, red fastest", () => {
    const { w, h } = latticeSize();
    const px = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([...latticeColor(x, y), 1], (y * w + x) * 4);
    const lut = lutFromPixels(px);
    expect(lut).toHaveLength(LUT_SIZE ** 3 * 3);
    // entry n = r + 33 g + 1089 b
    for (const [r, g, b] of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [32, 32, 32], [3, 17, 29]] as const) {
      const n = (r + 33 * g + 1089 * b) * 3;
      near([lut[n] as number, lut[n + 1] as number, lut[n + 2] as number], [r / 32, g / 32, b / 32], 1e-6);
    }
  });

  it("an empty look bakes the identity", () => {
    const lut = bakeLutCPU({ ops: [] });
    for (let i = 0; i < 33; i++) near([lut[i * 3] as number, lut[i * 3 + 1] as number, lut[i * 3 + 2] as number], [i / 32, 0, 0], 1e-6);
  });

  it("a baked LUT matches evaluating the ops directly (trilinear lookup, within 2/255)", () => {
    const l = (builtInLook("teal-orange") as NonNullable<ReturnType<typeof builtInLook>>).recipe;
    const { table } = lutPlan(l, 1);
    const lut = bakeLutCPU(table);
    const { data, count } = packTable(table);
    const sample = (c: readonly number[]): number[] => {
      const f = c.map((v) => v * 32);
      const i = f.map((v) => Math.min(31, Math.floor(v)));
      const t = f.map((v, k) => v - (i[k] as number));
      const out = [0, 0, 0];
      for (let corner = 0; corner < 8; corner++) {
        const dr = corner & 1;
        const dg = (corner >> 1) & 1;
        const db = (corner >> 2) & 1;
        const w = (dr ? (t[0] as number) : 1 - (t[0] as number)) * (dg ? (t[1] as number) : 1 - (t[1] as number)) * (db ? (t[2] as number) : 1 - (t[2] as number));
        const n = ((i[0] as number) + dr + 33 * ((i[1] as number) + dg) + 1089 * ((i[2] as number) + db)) * 3;
        for (let k = 0; k < 3; k++) out[k] = (out[k] as number) + w * (lut[n + k] as number);
      }
      return out;
    };
    for (const c of TEST_COLORS) near(sample(c), evalRows(data, count, c), 2 / 255);
  });
});

describe("LUT plan", () => {
  it("keeps the colour-only ops at region all and lists what a LUT can't hold", () => {
    const l = (builtInLook("neon-noir") as NonNullable<ReturnType<typeof builtInLook>>).recipe;
    const plan = lutPlan(l, 1);
    expect(plan.table.ops.map((o) => o.kind)).toEqual(["split"]); // the balance/gradmap ops are region-bound
    expect(plan.left.join("\n")).toMatch(/region/i);
    expect(plan.left.join("\n")).toMatch(/spatial/i);
    expect(plan.left.join("\n")).toMatch(/texture/i);
  });

  it("includes every region-less colour op, scaled by the wildness, and lists motion", () => {
    const r: GradeRecipe = {
      v: 1, name: "t", tier: "mine", seed: 0, wildCurve: "linear",
      ops: [
        { id: "a00001", kind: "chanmix", on: true, amount: 1, region: { kind: "all" }, params: { matrix: CHANMIX_PRESETS.brg as number[] } },
        { id: "a00002", kind: "huecycle", on: true, amount: 0.5, region: { kind: "all" }, params: {}, anim: { speed: 1, wave: "sine" } },
        { id: "a00003", kind: "bleach", on: false, amount: 1, region: { kind: "all" }, params: {} },
        { id: "a00004", kind: "invert", on: true, chaos: true, amount: 1, region: { kind: "all" }, params: {} },
      ],
    };
    const lo = lutPlan(r, 0.5);
    expect(lo.table.ops.map((o) => o.kind)).toEqual(["chanmix", "huecycle"]);
    expect(lo.left).toEqual(["Hue cycle: motion"]);
    const hi = lutPlan(r, 1);
    expect(hi.table.ops.map((o) => o.kind)).toEqual(["chanmix", "huecycle", "invert"]);
    expect(hi.table.ops[0]?.amount).toBeGreaterThan(lo.table.ops[0]?.amount ?? 1);
  });
});
