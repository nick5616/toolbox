import { describe, expect, it } from "vitest";
import { CLIP_POST_TYPES, LOOK_POST_TYPES } from "@/viz/edit/schema";
import { EFFECT_CATALOG, EFFECT_CATEGORIES, effectInfo } from "./effectCatalog";

describe("effect catalog", () => {
  it("has a label, description and known category for every allowed effect id", () => {
    const ids = new Set([...CLIP_POST_TYPES, ...LOOK_POST_TYPES]);
    expect(ids.size).toBeGreaterThan(30);
    for (const id of ids) {
      const info = effectInfo(id);
      expect(info, id).toBeDefined();
      expect(info.label.length, id).toBeGreaterThan(0);
      expect(info.description.length, id).toBeGreaterThan(0);
      expect(EFFECT_CATEGORIES, id).toContain(info.category);
    }
  });

  it("uses every category and has no duplicate labels", () => {
    const infos = Object.values(EFFECT_CATALOG);
    for (const c of EFFECT_CATEGORIES) expect(infos.some((i) => i.category === c), c).toBe(true);
    const labels = infos.map((i) => i.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
