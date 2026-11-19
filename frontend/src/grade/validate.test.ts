import { describe, expect, it } from "vitest";
import vectors from "../../../core/testdata/grade-recipes.json";
import { MAX_OPS, type GradeRecipe } from "./types";
import { parseRecipe, validateRecipe } from "./validate";

describe("recipe validation: the shared vectors", () => {
  it.each(vectors.valid.map((v, i) => [i, v] as const))("valid #%i is accepted unchanged", (_i, v) => {
    const r = validateRecipe(v);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.recipe).toEqual(v);
  });

  it.each(vectors.invalid.map((v) => [v.why, v.recipe] as const))("invalid: %s", (_why, recipe) => {
    const r = validateRecipe(recipe);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });

  it.each(vectors.clamped.map((v) => [v.why, v.in, v.out] as const))("clamped: %s", (_why, input, out) => {
    const r = validateRecipe(input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.recipe).toEqual(out);
  });
});

describe("recipe validation: limits", () => {
  const op = (i: number) => ({ id: `o${i}`, kind: "bleach", on: true, amount: 1, region: { kind: "all" }, params: {} });
  const base = { v: 1, name: "x", tier: "film", seed: 0, wildCurve: "linear" };

  it("keeps the first 16 ops", () => {
    const r = validateRecipe({ ...base, ops: Array.from({ length: 20 }, (_, i) => op(i)) });
    expect(r.ok && r.recipe.ops.map((o) => o.id)).toEqual(Array.from({ length: MAX_OPS }, (_, i) => `o${i}`));
  });

  it("counts a duplicate id even among the dropped extras", () => {
    const r = validateRecipe({ ...base, ops: [...Array.from({ length: 17 }, (_, i) => op(i)), op(0)] });
    expect(r.ok).toBe(false);
  });

  it("drops unknown kinds before checking ids", () => {
    const r = validateRecipe({ ...base, ops: [{ id: "same", kind: "teleport" }, { id: "same", kind: "bleach" }] });
    expect(r.ok).toBe(true);
  });

  it("cuts the name by code points", () => {
    const r = validateRecipe({ ...base, name: "😀".repeat(50), ops: [] });
    expect(r.ok && Array.from(r.recipe.name).length).toBe(40);
  });

  it("refuses text that isn't JSON", () => {
    expect(parseRecipe("{nope").ok).toBe(false);
    const ok = parseRecipe(JSON.stringify({ ...base, ops: [] }));
    expect(ok.ok).toBe(true);
  });

  it("is idempotent", () => {
    for (const v of vectors.clamped) {
      const once = validateRecipe(v.in);
      if (!once.ok) throw new Error("clamped vector refused");
      expect(validateRecipe(once.recipe)).toEqual({ ok: true, recipe: once.recipe as GradeRecipe });
    }
  });
});
