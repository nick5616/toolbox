import { describe, expect, it } from "vitest";
import { POST_TYPES } from "@/viz/types";
import "@/viz/post";
import { postDef } from "@/viz/post/registry";
import { BUILT_IN_LOOKS } from "./looks";
import { CHANMIX_PRESETS, defaultParams, isGradeLookKind, OP_DEFS, opParams } from "./ops";
import { GRADE_OP_KINDS } from "./types";
import { clampParam } from "./validate";

describe("op catalog", () => {
  it("has an entry for every kind, with a label, an effect line and params that clamp to themselves", () => {
    for (const kind of GRADE_OP_KINDS) {
      const d = OP_DEFS[kind];
      expect(d.kind).toBe(kind);
      expect(d.label.length).toBeGreaterThan(2);
      expect(d.effect.length).toBeGreaterThan(10);
      for (const [k, spec] of Object.entries(d.params)) {
        expect(spec.label, `${kind}.${k}`).toBeTruthy();
        expect(clampParam(spec, spec.default), `${kind}.${k} default`).toEqual(spec.default);
        if (spec.kind === "number") expect(spec.min).toBeLessThan(spec.max as number);
      }
    }
  });

  it("marks the colour-only ops exactly as the spec lists them", () => {
    const colour = GRADE_OP_KINDS.filter((k) => OP_DEFS[k].colorOnly);
    expect(colour).toEqual(["balance", "wheels", "curves", "hsl", "split", "gradmap", "chanmix", "solarize", "posterize", "invert", "huecycle", "transfer", "bleach"]);
    expect(GRADE_OP_KINDS.filter(isGradeLookKind)).toEqual([...colour, "grain", "vignette"]);
  });

  it("declares the depth need of depthfog and tiltshift, and their passes read it", () => {
    expect(OP_DEFS.depthfog.needs).toEqual(["depth"]);
    expect(OP_DEFS.tiltshift.needs).toEqual(["depth"]);
    expect(postDef("depthfog")?.needs).toEqual(["depth"]);
    expect(postDef("tiltshift")?.needs).toEqual(["depth"]);
    expect(postDef("gradelook")?.needs).toContain("subject");
  });

  it("catalog matches POST_TYPES: every spatial kind is a registered pass with the params the compiler fills", () => {
    const spatial = GRADE_OP_KINDS.filter((k) => !isGradeLookKind(k));
    for (const k of spatial) {
      expect((POST_TYPES as readonly string[]).includes(k), k).toBe(true);
      expect(postDef(k as never), `${k} registered`).toBeTruthy();
    }
    for (const t of ["gradelook", "halation", "edgeglow", "depthfog", "tiltshift"] as const) {
      expect((POST_TYPES as readonly string[]).includes(t)).toBe(true);
      const def = postDef(t);
      expect(def?.kind).toBe("pass");
      // identity at defaults: the amount defaults to 0 (gradelook: an empty table)
      const amount = def?.params.amount;
      if (amount?.kind === "number") expect(amount.default).toBe(0);
    }
    expect(postDef("gradelook")?.params.table).toMatchObject({ default: "[]" });
  });

  it("every look's ops are in the catalog, params known and in range, with unique 6-char ids", () => {
    expect(BUILT_IN_LOOKS).toHaveLength(40);
    const ids = new Set<string>();
    for (const l of BUILT_IN_LOOKS) {
      expect(ids.has(l.id), `duplicate look id ${l.id}`).toBe(false);
      ids.add(l.id);
      expect(l.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      const opIds = new Set<string>();
      expect(l.recipe.ops.length).toBeLessThanOrEqual(16);
      for (const o of l.recipe.ops) {
        expect(opIds.has(o.id), `${l.id} duplicate op id`).toBe(false);
        opIds.add(o.id);
        expect(o.id).toHaveLength(6);
        const def = OP_DEFS[o.kind];
        expect(def, `${l.id}: ${o.kind}`).toBeTruthy();
        for (const [k, v] of Object.entries(o.params)) {
          const spec = def.params[k];
          expect(spec, `${l.id}.${o.kind}.${k}`).toBeTruthy();
          if (spec) expect(clampParam(spec, v), `${l.id}.${o.kind}.${k} in range`).toEqual(v);
        }
        if (o.anim) expect(def.animatable, `${l.id}: ${o.kind} can't animate`).toBe(true);
      }
    }
  });

  it("opParams fills defaults and keeps given values", () => {
    expect(opParams({ kind: "balance", params: { temp: 0.4 } })).toEqual({ ...defaultParams("balance"), temp: 0.4 });
    expect(CHANMIX_PRESETS.identity).toHaveLength(12);
    expect(opParams({ kind: "chanmix", params: {} }).matrix).toEqual(CHANMIX_PRESETS.identity);
  });
});
