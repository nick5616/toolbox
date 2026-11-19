import { describe, expect, it } from "vitest";
import { mulberry32, surprise } from "./chaos";
import { compileRecipe } from "./compile";
import { OP_DEFS } from "./ops";
import type { GradeOp } from "./types";
import { validateRecipe } from "./validate";

describe("mulberry32", () => {
  it("is deterministic, in [0, 1) and different per seed", () => {
    const a = mulberry32(4821);
    const b = mulberry32(4821);
    const xs = Array.from({ length: 50 }, () => a());
    expect(xs).toEqual(Array.from({ length: 50 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(mulberry32(4822)()).not.toBe(xs[0]);
  });
});

describe("surprise (Chaos)", () => {
  it("is deterministic: the same seed and wildness give the same recipe, JSON and all", () => {
    for (const seed of [1, 4821, 4294967295]) for (const w of [0, 0.5, 1]) expect(JSON.stringify(surprise(seed, w))).toBe(JSON.stringify(surprise(seed, w)));
  });

  it("different seeds give different looks", () => {
    const set = new Set(Array.from({ length: 30 }, (_, i) => JSON.stringify(surprise(i + 1, 0.7).ops)));
    expect(set.size).toBe(30);
  });

  it("builds 3 to 8 valid ops, in the catalog, with unique ids, and the recipe validates unchanged", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const w = (seed % 11) / 10;
      const r = surprise(seed, w);
      expect(r.ops.length, `seed ${seed}`).toBeGreaterThanOrEqual(3);
      expect(r.ops.length).toBeLessThanOrEqual(8);
      expect(new Set(r.ops.map((o) => o.id)).size).toBe(r.ops.length);
      expect(new Set(r.ops.map((o) => o.kind)).size, "no repeated kinds").toBe(r.ops.length);
      for (const o of r.ops) expect(OP_DEFS[o.kind]).toBeTruthy();
      const v = validateRecipe(r);
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.recipe).toEqual(r);
      expect(r.name).toBe(`Chaos #${seed}`);
    }
  });

  it("is tamer at low Wildness and wilder at high: more wild kinds and more ops", () => {
    const WILD = new Set(["gradmap", "chanmix", "huecycle", "solarize", "posterize", "invert", "edgeglow", "glitch", "mirror", "halftone", "chromatic", "vhs"]);
    const share = (w: number) => {
      let wild = 0;
      let total = 0;
      let n = 0;
      for (let s = 1; s <= 150; s++) {
        const r = surprise(s, w);
        n += r.ops.length;
        for (const o of r.ops) {
          total++;
          if (WILD.has(o.kind)) wild++;
        }
      }
      return { share: wild / total, ops: n / 150 };
    };
    const low = share(0);
    const high = share(1);
    expect(high.share).toBeGreaterThan(low.share + 0.2);
    expect(high.ops).toBeGreaterThan(low.ops);
  });

  it("keeps locked ops, in order, at the front, across rerolls, and doesn't draw their kinds again", () => {
    const first = surprise(100, 0.8);
    const locked: GradeOp[] = [first.ops[1] as GradeOp, first.ops[2] as GradeOp];
    for (let seed = 101; seed <= 110; seed++) {
      const r = surprise(seed, 0.8, locked);
      expect(r.ops[0]).toBe(locked[0]);
      expect(r.ops[1]).toBe(locked[1]);
      expect(r.ops.filter((o) => o.kind === locked[0]?.kind)).toHaveLength(1);
      expect(r.ops.filter((o) => o.kind === locked[1]?.kind)).toHaveLength(1);
      expect(r.ops.length).toBeLessThanOrEqual(8);
      expect(new Set(r.ops.map((o) => o.id)).size).toBe(r.ops.length);
    }
    // with every slot locked nothing new is drawn
    const full = surprise(5, 1, Array.from({ length: 8 }, (_, i) => ({ ...(first.ops[0] as GradeOp), id: `l0000${i}` })));
    expect(full.ops).toHaveLength(8);
  });

  it("marks the loud kinds chaos, and compiles at every wildness", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = surprise(seed, 1);
      for (const o of r.ops) if (["edgeglow", "glitch", "mirror", "halftone", "chromatic", "invert", "solarize"].includes(o.kind)) expect(o.chaos).toBe(true);
      for (const w of [0, 0.5, 1]) expect(() => compileRecipe(r, w, { depth: true, subject: true, people: true })).not.toThrow();
    }
  });
});
